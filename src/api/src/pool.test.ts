import { limitsFor, runtimeConfig } from "@swarm/shared/server";
import { describe, expect, it } from "vitest";
import { acquireSlot, poolTimes, releaseSlot } from "./pool.js";
import { MemoryStore } from "./storage/memory.js";

const scoutLimit = limitsFor("scout").concurrency;
const take = (store: MemoryStore, runId: string, now = 1_000, options = {}) =>
  acquireSlot(store, { tier: "scout", runId, now, ...options });

describe("per-depth concurrency pools", () => {
  it("starts runs up to the depth's limit and queues the rest, first come first served", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < scoutLimit; i++) {
      expect(await take(store, `run_${i}`, 1_000 + i)).toEqual({ status: "acquired" });
    }
    // Two more than the pool allows: they queue (and are told how many are ahead).
    expect(await take(store, "run_a", 2_000)).toEqual({ status: "waiting", ahead: 0 });
    expect(await take(store, "run_b", 2_001)).toEqual({ status: "waiting", ahead: 1 });
    // Asking again keeps the place in the queue and does not start early.
    expect(await take(store, "run_b", 3_000)).toEqual({ status: "waiting", ahead: 1 });

    // A slot frees: the one that has waited longest is next; the later one still waits.
    await releaseSlot(store, { tier: "scout", runId: "run_0" });
    expect(await take(store, "run_b", 3_100)).toEqual({ status: "waiting", ahead: 1 });
    expect(await take(store, "run_a", 3_100)).toEqual({ status: "acquired" });
    expect(await take(store, "run_b", 3_200)).toEqual({ status: "waiting", ahead: 0 });
    await releaseSlot(store, { tier: "scout", runId: "run_1" });
    expect(await take(store, "run_b", 3_300)).toEqual({ status: "acquired" });
  });

  it("is idempotent for a run that already holds a slot, and for releases", async () => {
    const store = new MemoryStore();
    expect(await take(store, "run_x")).toEqual({ status: "acquired" });
    expect(await take(store, "run_x")).toEqual({ status: "acquired" });
    await releaseSlot(store, { tier: "scout", runId: "run_x" });
    await releaseSlot(store, { tier: "scout", runId: "run_x" });
    await releaseSlot(store, { tier: "scout", runId: "never_seen" });
    for (let i = 0; i < scoutLimit; i++)
      expect((await take(store, `run_${i}`)).status).toBe("acquired");
  });

  it("never lets frequent cheap scans delay a deeper one: every depth has its own pool", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < scoutLimit + 3; i++) await take(store, `scout_${i}`);
    // Scout is full and has a queue, yet a Siege starts at once, and so does a Probe and a Sweep.
    for (const tier of ["siege", "probe", "sweep"] as const) {
      expect(await acquireSlot(store, { tier, runId: `${tier}_1`, now: 1_000 })).toEqual({
        status: "acquired",
      });
    }
    // A depth with its own limit queues only its own runs.
    const siege = limitsFor("siege").concurrency;
    for (let i = 2; i <= siege; i++) {
      await acquireSlot(store, { tier: "siege", runId: `siege_${i}`, now: 1_000 });
    }
    expect(await acquireSlot(store, { tier: "siege", runId: "siege_late", now: 1_000 })).toEqual({
      status: "waiting",
      ahead: 0,
    });
  });

  it("keeps test runs in their own pool, so a test cannot block a customer", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < scoutLimit; i++) await take(store, `test_${i}`, 1_000, { test: true });
    expect((await take(store, "test_more", 1_000, { test: true })).status).toBe("waiting");
    expect(await take(store, "customer_1")).toEqual({ status: "acquired" });
    const keys = await store.list("admin/pools/");
    expect(keys.sort()).toEqual(["admin/pools/scout.json", "admin/pools/test/scout.json"]);
  });

  it("reuses a slot whose run vanished (no finalise), after the depth's longest run plus grace", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < scoutLimit; i++) await take(store, `lost_${i}`, 0);
    expect((await take(store, "next", 1_000)).status).toBe("waiting");
    const { staleMs } = poolTimes("scout");
    expect(await take(store, "next", staleMs + 1)).toEqual({ status: "acquired" });
  });

  it("declines a run that has waited longer than the queue timeout", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < scoutLimit; i++) await take(store, `busy_${i}`, 0);
    expect((await take(store, "patient", 1)).status).toBe("waiting");
    const timeout = runtimeConfig.pool.queueTimeoutMinutes * 60_000;
    expect(await take(store, "patient", timeout + 2)).toEqual({ status: "declined" });
    // It left the queue: a later run is not stuck behind it.
    await releaseSlot(store, { tier: "scout", runId: "busy_0" });
    expect(await take(store, "later", timeout + 3)).toEqual({ status: "acquired" });
  });

  it("holds under concurrent starts: never more runs than the limit", async () => {
    const store = new MemoryStore();
    const results = await Promise.all(
      Array.from({ length: scoutLimit * 3 }, (_, i) => take(store, `race_${i}`, 5_000)),
    );
    expect(results.filter((r) => r.status === "acquired")).toHaveLength(scoutLimit);
    expect(results.filter((r) => r.status === "waiting")).toHaveLength(scoutLimit * 2);
  });
});
