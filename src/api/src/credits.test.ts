import { describe, expect, it } from "vitest";
import { getCredits, grantCredits, refundCredit, spendCredit } from "./credits.js";
import { MemoryStore } from "./storage/memory.js";

const HASH = "a".repeat(64);
const grant = (store: MemoryStore, tier: "scout" | "sweep" | "probe" | "siege", count: number) =>
  grantCredits(store, HASH, { tier, count, source: "comp", reason: "test", by: "tester" }, 1000);

describe("credit ledger", () => {
  it("a new account has zero credits for every depth", async () => {
    expect(await getCredits(new MemoryStore(), HASH)).toEqual({
      scout: 0,
      sweep: 0,
      probe: 0,
      siege: 0,
    });
  });

  it("grants credits per depth and keeps each grant in the audit trail", async () => {
    const store = new MemoryStore();
    await grant(store, "sweep", 2);
    expect(await grant(store, "siege", 1)).toEqual({ scout: 0, sweep: 2, probe: 0, siege: 1 });
    const ledger = JSON.parse((await store.get(`users/${HASH}/entitlements.json`))!.body);
    expect(ledger.grants).toEqual([
      { at: 1000, source: "comp", tier: "sweep", count: 2, reason: "test", by: "tester" },
      { at: 1000, source: "comp", tier: "siege", count: 1, reason: "test", by: "tester" },
    ]);
    expect(ledger.granted.comp).toMatchObject({ sweep: 2, siege: 1 });
  });

  it("spends a credit of the right depth only", async () => {
    const store = new MemoryStore();
    await grant(store, "scout", 3);
    expect(await spendCredit(store, HASH, "siege", 2000)).toBe(false);
    expect(await spendCredit(store, HASH, "scout", 2000)).toBe(true);
    expect((await getCredits(store, HASH)).scout).toBe(2);
  });

  it("spends nothing for an account with no ledger", async () => {
    const store = new MemoryStore();
    expect(await spendCredit(store, HASH, "scout", 2000)).toBe(false);
    expect(await store.list("users/")).toEqual([]);
  });

  it("with one credit, fifty concurrent spends succeed exactly once", async () => {
    const store = new MemoryStore();
    await grant(store, "probe", 1);
    const results = await Promise.all(
      Array.from({ length: 50 }, () => spendCredit(store, HASH, "probe", 2000)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await getCredits(store, HASH)).probe).toBe(0);
  });

  it("concurrent grants do not lose updates", async () => {
    const store = new MemoryStore();
    await Promise.all(Array.from({ length: 20 }, () => grant(store, "scout", 1)));
    expect((await getCredits(store, HASH)).scout).toBe(20);
  });

  it("refunds a spent credit, never below what was spent", async () => {
    const store = new MemoryStore();
    await grant(store, "scout", 1);
    await spendCredit(store, HASH, "scout", 2000);
    await refundCredit(store, HASH, "scout", 3000);
    await refundCredit(store, HASH, "scout", 3000);
    expect((await getCredits(store, HASH)).scout).toBe(1);
  });
});
