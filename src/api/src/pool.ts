import { tiers, type TierId } from "@swarm/shared";
import { limitsFor, runtimeConfig } from "@swarm/shared/server";
import { z } from "zod";
import { claimRun, getRunFile, runFileSchema } from "./runs.js";
import { updateJson } from "./storage/json.js";
import { keys } from "./storage/keys.js";
import type { ObjectStore } from "./storage/store.js";

/**
 * Per-depth concurrency pools (PLAN.md section 11): at most `concurrency` runs of one depth execute
 * at once, so frequent cheap scans cannot starve the deep ones. Each depth has its own pool, a run
 * only ever waits for its own depth, and waiting runs go first come, first served. State is one small
 * S3 object per pool, updated with compare-and-swap; test runs have their own pool so a test can never
 * hold up a real customer.
 */
const poolSchema = z.object({
  test: z.boolean().optional(),
  /** Run id -> when it took its slot (epoch ms). */
  active: z.record(z.string(), z.number()),
  /** Run id -> when it started waiting (epoch ms). */
  waiting: z.record(z.string(), z.number()),
});

export type AcquireResult =
  { status: "acquired" } | { status: "waiting"; ahead: number } | { status: "declined" };

interface PoolTimes {
  /** A slot older than this is assumed leaked (its run died without finalising) and is reused. */
  staleMs: number;
  /** A run that has waited this long is declined. */
  timeoutMs: number;
}

export const poolTimes = (tier: TierId): PoolTimes => ({
  staleMs:
    (tiers[tier].wallClockMinutes * 60 +
      runtimeConfig.taskTimeoutMarginSeconds +
      runtimeConfig.reaper.graceMinutes * 60) *
    1000,
  timeoutMs: runtimeConfig.pool.queueTimeoutMinutes * 60 * 1000,
});

const fresh = (entries: Record<string, number>, now: number, maxAgeMs: number) =>
  Object.fromEntries(Object.entries(entries).filter(([, at]) => now - at < maxAgeMs));

/** Takes a slot for the run if one is free and nobody has waited longer; otherwise joins the queue. */
export async function acquireSlot(
  store: ObjectStore,
  options: {
    tier: TierId;
    runId: string;
    test?: boolean;
    now: number;
    /** Defaults to the depth's configured concurrency. */
    limit?: number;
  },
): Promise<AcquireResult> {
  const { tier, runId, now } = options;
  const limit = options.limit ?? limitsFor(tier).concurrency;
  const times = poolTimes(tier);
  let result: AcquireResult = { status: "declined" };

  await updateJson(store, keys.pool(tier, options.test === true), poolSchema, (current) => {
    const active = fresh(current?.active ?? {}, now, times.staleMs);
    // A waiter that stopped asking (its execution is gone) must not block everyone behind it.
    const waiting = fresh(current?.waiting ?? {}, now, times.timeoutMs + 5 * 60 * 1000);
    const next = (): z.infer<typeof poolSchema> => ({
      ...(options.test ? { test: true as const } : {}),
      active,
      waiting,
    });

    if (runId in active) {
      result = { status: "acquired" };
      return next();
    }
    const since = waiting[runId] ?? now;
    if (now - since > times.timeoutMs) {
      delete waiting[runId];
      result = { status: "declined" };
      return next();
    }
    const ahead = Object.entries(waiting).filter(
      ([id, at]) => id !== runId && (at < since || (at === since && id < runId)),
    ).length;
    if (Object.keys(active).length + ahead < limit) {
      delete waiting[runId];
      active[runId] = now;
      result = { status: "acquired" };
    } else {
      waiting[runId] = since;
      result = { status: "waiting", ahead };
    }
    return next();
  });
  return result;
}

/** Gives the slot back and leaves the queue. Safe to call for a run that holds neither. */
export async function releaseSlot(
  store: ObjectStore,
  options: { tier: TierId; runId: string; test?: boolean },
): Promise<void> {
  await updateJson(store, keys.pool(options.tier, options.test === true), poolSchema, (current) => {
    if (!current || (!(options.runId in current.active) && !(options.runId in current.waiting))) {
      return undefined;
    }
    const active = { ...current.active };
    const waiting = { ...current.waiting };
    delete active[options.runId];
    delete waiting[options.runId];
    return { ...current, active, waiting };
  });
}

/**
 * State machine step 1: moves a queued run into its depth's pool and starts it, or tells the
 * caller to wait. While it waits, the run's `reason` says so, in customer terms.
 */
export async function acquireRun(
  store: ObjectStore,
  ids: { emailHash: string; runId: string },
  now: number,
): Promise<AcquireResult> {
  const run = await getRunFile(store, ids.emailHash, ids.runId);
  if (!run) throw new Error("run_not_found");
  const got = await acquireSlot(store, {
    tier: run.tier,
    runId: ids.runId,
    test: run.test,
    now,
  });
  if (got.status === "acquired") {
    const claimed = await claimRun(store, ids.emailHash, ids.runId, now);
    if (!claimed) {
      // Stopped while it waited: the slot is not needed.
      await releaseSlot(store, { tier: run.tier, runId: ids.runId, test: run.test });
      throw new Error("run_not_queued");
    }
    return got;
  }
  if (got.status === "waiting") {
    const position = got.ahead + 1;
    await updateJson(store, keys.runSummary(ids.emailHash, ids.runId), runFileSchema, (current) =>
      current && current.status === "queued"
        ? {
            ...current,
            reason: `Waiting for a free ${tiers[run.tier].name} slot${position > 1 ? ` (${position - 1} ahead of you)` : ""}. It starts by itself.`,
          }
        : undefined,
    );
  }
  return got;
}
