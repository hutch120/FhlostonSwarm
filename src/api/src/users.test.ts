import { describe, expect, it } from "vitest";
import { MemoryStore } from "./storage/memory.js";
import { claimFreeReport, hasClaimedFreeReport, recordLogin } from "./users.js";

const HASH = "c".repeat(64);

describe("free-claim primitive", () => {
  it("is claimed once, then refused", async () => {
    const store = new MemoryStore();
    expect(await hasClaimedFreeReport(store, HASH)).toBe(false);
    expect(await claimFreeReport(store, HASH, 1)).toBe("claimed");
    expect(await claimFreeReport(store, HASH, 2)).toBe("already-claimed");
    expect(await hasClaimedFreeReport(store, HASH)).toBe(true);
  });

  it("50 concurrent claims: exactly one succeeds", async () => {
    const store = new MemoryStore();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => claimFreeReport(store, HASH, 1)),
    );
    expect(results.filter((r) => r === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r === "already-claimed")).toHaveLength(49);
  });

  it("the marker holds no personal data", async () => {
    const store = new MemoryStore();
    await claimFreeReport(store, HASH, 123);
    expect(JSON.parse((await store.get(`claims/free/${HASH}.json`))!.body)).toEqual({
      claimedAt: 123,
    });
  });
});

describe("recordLogin", () => {
  it("creates the profile once and then only updates the login time and role", async () => {
    const store = new MemoryStore();
    const first = await recordLogin(store, HASH, "buyer@example.com", "customer", 10);
    expect(first).toEqual({
      email: "buyer@example.com",
      role: "customer",
      createdAt: 10,
      lastLoginAt: 10,
    });
    const second = await recordLogin(store, HASH, "buyer@example.com", "staff", 20);
    expect(second).toEqual({
      email: "buyer@example.com",
      role: "staff",
      createdAt: 10,
      lastLoginAt: 20,
    });
  });
});
