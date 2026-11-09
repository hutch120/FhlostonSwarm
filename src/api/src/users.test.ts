import { describe, expect, it } from "vitest";
import { MemoryStore } from "./storage/memory.js";
import { recordLogin } from "./users.js";
import { createJson } from "./storage/json.js";

const HASH = "c".repeat(64);

describe("conditional create (the atomic primitive entitlements and run starts rely on)", () => {
  it("is created once, then refused", async () => {
    const store = new MemoryStore();
    expect(await createJson(store, "once.json", { n: 1 })).toBe(true);
    expect(await createJson(store, "once.json", { n: 2 })).toBe(false);
    expect(JSON.parse((await store.get("once.json"))!.body)).toEqual({ n: 1 });
  });

  it("50 concurrent creates: exactly one succeeds", async () => {
    const store = new MemoryStore();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => createJson(store, "race.json", { n: 1 })),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
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
