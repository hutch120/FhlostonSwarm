import {
  agentEventSchema,
  eventBatchSchema,
  type AgentEvent,
  type AgentSpec,
  type EventBatch,
  type Finding,
} from "@swarm/shared";
import { randomUUID } from "node:crypto";

/** Where batches of events go: the events API in a task, memory in tests and local runs. */
export interface EventSink {
  send(batch: EventBatch): Promise<void>;
}

export class MemorySink implements EventSink {
  readonly batches: EventBatch[] = [];
  async send(batch: EventBatch): Promise<void> {
    this.batches.push(batch);
  }
  get events(): AgentEvent[] {
    return this.batches.flatMap((b) => b.events);
  }
}

export interface EmitterOptions {
  runId: string;
  sink: EventSink;
  now?: () => number;
  /** Flush when this many events are waiting. */
  batchSize?: number;
  /** Flush at least this often while events are waiting. */
  flushMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  newBatchId?: () => string;
}

type FinishPayload = Extract<AgentEvent, { type: "finish" }>["payload"];
type Outcome =
  | { outcome: "clear" }
  | { outcome: "info"; note: string }
  | { outcome: "finding"; finding: Finding }
  | { outcome: "gap"; reason: string };

/**
 * The typed event emitter. Every event is validated against the shared contract before it is queued,
 * then sent in small batches. A batch is retried with the same id, so the API can drop a duplicate.
 */
export class Emitter {
  private queue: AgentEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly batchSize: number;
  private readonly flushMs: number;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newBatchId: () => string;
  /** Set when a batch could not be delivered after every retry. */
  failure: Error | null = null;

  constructor(private readonly options: EmitterOptions) {
    this.now = options.now ?? Date.now;
    this.batchSize = options.batchSize ?? 20;
    this.flushMs = options.flushMs ?? 500;
    this.retries = options.retries ?? 4;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.newBatchId = options.newBatchId ?? randomUUID;
  }

  private base() {
    return { ts: new Date(this.now()).toISOString(), runId: this.options.runId };
  }

  private push(event: unknown): void {
    this.queue.push(agentEventSchema.parse(event));
    if (this.queue.length >= this.batchSize) void this.flush();
    else this.timer ??= setTimeout(() => void this.flush(), this.flushMs);
  }

  dispatch(agent: string, task: string, spec?: AgentSpec): void {
    this.push({
      ...this.base(),
      type: "dispatch",
      agent,
      payload: spec ? { task, spec } : { task },
    });
  }

  start(agent: string, stepId: string, label: string): void {
    this.push({ ...this.base(), type: "start", agent, payload: { stepId, label } });
  }

  finish(agent: string, stepId: string, label: string, requests: number, result: Outcome): void {
    const payload = { stepId, label, requests, ...result } as FinishPayload;
    this.push({ ...this.base(), type: "finish", agent, payload });
  }

  agentDone(agent: string, summary: string): void {
    this.push({ ...this.base(), type: "agent-done", agent, payload: { summary } });
  }

  /** An independent re-test of a finding: `verified` false marks it unconfirmed. */
  verify(agent: string, findingId: string, verified: boolean, note: string): void {
    this.push({ ...this.base(), type: "verify", agent, payload: { findingId, verified, note } });
  }

  gap(agent: string | null, reason: string, area?: string): void {
    this.push({
      ...this.base(),
      type: "gap",
      agent,
      payload: area ? { reason, area } : { reason },
    });
  }

  /** Sends everything queued; resolves when it is delivered (or has failed for good). */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const events = this.queue.splice(0, this.queue.length);
    if (events.length === 0) return this.chain;
    const batches: EventBatch[] = [];
    for (let i = 0; i < events.length; i += 100) {
      batches.push(
        eventBatchSchema.parse({ batchId: this.newBatchId(), events: events.slice(i, i + 100) }),
      );
    }
    // One at a time and in order: the API assigns seq in arrival order.
    this.chain = this.chain.then(async () => {
      for (const batch of batches) await this.deliver(batch);
    });
    return this.chain;
  }

  private async deliver(batch: EventBatch): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        await this.options.sink.send(batch);
        return;
      } catch (err) {
        lastError = err;
        await this.sleep(Math.min(5000, 250 * 2 ** attempt));
      }
    }
    this.failure = lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
