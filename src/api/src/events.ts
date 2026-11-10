import {
  applyEvents,
  createRunState,
  runEventSchema,
  tierRoster,
  type RunEvent,
  type RunState,
  type TierId,
} from "@swarm/shared";
import { z } from "zod";
import { reject } from "./http.js";
import type { EventPublisher } from "./publisher.js";
import { getJson, putJson } from "./storage/json.js";
import { keys } from "./storage/keys.js";
import { PreconditionFailedError, type ObjectStore } from "./storage/store.js";

const BATCH_MEMORY = 64;
const PAGE_EVENTS = 500;
const CHUNK = /\/events\/(\d{9})-(\d{9})\.json$/;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event that has not been given its place in the stream yet. */
export type DraftEvent = DistributiveOmit<RunEvent, "seq">;

const stamp = (draft: DraftEvent, seq: number): RunEvent => runEventSchema.parse({ ...draft, seq });

/**
 * The sequencer for one run's event log. The run state is the reducer's folded state (without the
 * log), so each batch costs one read and one conditional write however long the run has been.
 */
const sequencerSchema = z.object({
  test: z.boolean().optional(),
  lastSeq: z.number().int().nonnegative(),
  /** Recent batches, so a retried POST is recognised and not applied twice. */
  batches: z.array(
    z.object({ id: z.string(), firstSeq: z.number().int().positive(), count: z.number().int() }),
  ),
  run: z.custom<RunState>((value) => typeof value === "object" && value !== null),
});
export type Sequencer = z.infer<typeof sequencerSchema>;

const chunkSchema = z.object({ test: z.boolean().optional(), events: z.array(runEventSchema) });

export interface EventScope {
  emailHash: string;
  runId: string;
  tier: TierId;
  test?: boolean;
}

const mark = (scope: EventScope) => (scope.test ? { test: true as const } : {});

const freshState = (scope: EventScope): Sequencer => {
  const { areas, agents } = tierRoster(scope.tier);
  return {
    ...mark(scope),
    lastSeq: 0,
    batches: [],
    run: { ...createRunState({ runId: scope.runId, tier: scope.tier, areas, agents }), log: [] },
  };
};

export async function getSequencer(store: ObjectStore, scope: EventScope): Promise<Sequencer> {
  const found = await getJson(
    store,
    keys.runEventState(scope.emailHash, scope.runId),
    sequencerSchema,
  );
  return found?.value ?? freshState(scope);
}

export interface Appended {
  lastSeq: number;
  duplicate: boolean;
  events: RunEvent[];
  /** The folded run state after these events. */
  run: RunState;
}

async function writeChunk(
  store: ObjectStore,
  scope: EventScope,
  firstSeq: number,
  events: RunEvent[],
) {
  await putJson(
    store,
    keys.runEventChunk(scope.emailHash, scope.runId, firstSeq, firstSeq + events.length - 1),
    { ...mark(scope), events },
  );
}

/**
 * Appends events to a run's log: gives them their seq, folds them into the run state, stores the
 * chunk and publishes them. Idempotent per `batchId`, so a retried POST is not applied twice.
 */
export async function appendEvents(
  store: ObjectStore,
  scope: EventScope,
  batch: { batchId: string; events: DraftEvent[] },
  publisher?: EventPublisher,
): Promise<Appended> {
  const key = keys.runEventState(scope.emailHash, scope.runId);
  for (let attempt = 0; attempt < 30; attempt++) {
    const found = await getJson(store, key, sequencerSchema);
    const state = found?.value ?? freshState(scope);

    const seen = state.batches.find((b) => b.id === batch.batchId);
    if (seen) {
      // A retry: the range is reserved, so write the chunk again (idempotent) and publish again.
      const events = batch.events.map((e, i) => stamp(e, seen.firstSeq + i));
      await writeChunk(store, scope, seen.firstSeq, events);
      await publisher?.publish(scope.runId, events);
      return { lastSeq: state.lastSeq, duplicate: true, events, run: state.run };
    }

    const firstSeq = state.lastSeq + 1;
    const events = batch.events.map((e, i) => {
      if (e.runId !== scope.runId) reject(400, "wrong_run");
      return stamp(e, firstSeq + i);
    });
    const run = applyEvents(state.run, events);
    const next: Sequencer = {
      ...state,
      lastSeq: firstSeq + events.length - 1,
      batches: [
        ...state.batches.slice(-(BATCH_MEMORY - 1)),
        { id: batch.batchId, firstSeq, count: events.length },
      ],
      run: { ...run, log: [] },
    };
    try {
      await store.put(
        key,
        JSON.stringify(next),
        found ? { ifMatch: found.etag } : { ifNoneMatch: true },
      );
    } catch (err) {
      if (err instanceof PreconditionFailedError) continue;
      throw err;
    }
    await writeChunk(store, scope, firstSeq, events);
    await publisher?.publish(scope.runId, events);
    return { lastSeq: next.lastSeq, duplicate: false, events, run: next.run };
  }
  return reject(503, "busy");
}

export interface EventsPage {
  events: RunEvent[];
  lastSeq: number;
  more: boolean;
}

/** Events after `after`, in seq order, up to a page. Used for catch-up on reconnect. */
export async function readEvents(
  store: ObjectStore,
  scope: Pick<EventScope, "emailHash" | "runId">,
  after: number,
  limit = PAGE_EVENTS,
): Promise<EventsPage> {
  const chunks = (await store.list(keys.runEventsPrefix(scope.emailHash, scope.runId)))
    .flatMap((key) => {
      const m = CHUNK.exec(key);
      return m ? [{ key, first: Number(m[1]), last: Number(m[2]) }] : [];
    })
    .filter((c) => c.last > after)
    .sort((a, b) => a.first - b.first);

  const events: RunEvent[] = [];
  let more = false;
  for (const chunk of chunks) {
    if (events.length >= limit) {
      more = true;
      break;
    }
    const body = await store.get(chunk.key);
    if (!body) continue;
    const parsed = chunkSchema.parse(JSON.parse(body.body));
    for (const event of parsed.events) if (event.seq > after) events.push(event);
  }
  const lastSeq = chunks.at(-1)?.last ?? after;
  return { events, lastSeq: Math.max(lastSeq, events.at(-1)?.seq ?? 0, after), more };
}

/** The whole log, for the report. */
export async function readAllEvents(
  store: ObjectStore,
  scope: Pick<EventScope, "emailHash" | "runId">,
): Promise<RunEvent[]> {
  const all: RunEvent[] = [];
  let after = 0;
  for (;;) {
    const page = await readEvents(store, scope, after, 5000);
    all.push(...page.events);
    const last = page.events.at(-1)?.seq;
    if (!page.more || last === undefined) return all;
    after = last;
  }
}
