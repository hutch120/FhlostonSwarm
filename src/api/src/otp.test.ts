import { beforeEach, describe, expect, it } from "vitest";
import { issueChallenge, verifyChallenge } from "./otp.js";
import { MemoryStore } from "./storage/memory.js";
import { keys } from "./storage/keys.js";
import { createClock, testConfig } from "./testkit.js";

const PEPPER = "pepper";
const HASH = "a".repeat(64);
const config = testConfig();

let store: MemoryStore;
let clock: ReturnType<typeof createClock>;

beforeEach(() => {
  store = new MemoryStore();
  clock = createClock();
});

const issue = () => issueChallenge(store, PEPPER, HASH, "buyer@example.com", config, clock.now());
const verifyCode = (code: string) =>
  verifyChallenge(store, PEPPER, HASH, { code }, config, clock.now());

describe("OTP challenge", () => {
  it("issues a numeric code of the configured length and stores only hashes", async () => {
    const { code } = await issue();
    expect(code).toMatch(new RegExp(`^\\d{${config.otp.codeLength}}$`));
    const stored = (await store.get(keys.otp(HASH)))!.body;
    expect(stored).not.toContain(code);
  });

  it("accepts the right code once and then deletes the challenge", async () => {
    const { code } = await issue();
    expect(await verifyCode(code)).toEqual({ ok: true, email: "buyer@example.com" });
    expect(await store.get(keys.otp(HASH))).toBeNull();
    expect(await verifyCode(code)).toEqual({ ok: false });
  });

  it("rejects an expired code", async () => {
    const { code } = await issue();
    clock.advance(config.otp.ttlMinutes * 60_000 + 1);
    expect(await verifyCode(code)).toEqual({ ok: false });
  });

  it("accepts a code right up to the expiry", async () => {
    const { code } = await issue();
    clock.advance(config.otp.ttlMinutes * 60_000);
    expect((await verifyCode(code)).ok).toBe(true);
  });

  it("locks after the maximum number of wrong attempts, even for the right code", async () => {
    const { code } = await issue();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < config.otp.maxAttempts; i++)
      expect(await verifyCode(wrong)).toEqual({ ok: false });
    expect(await verifyCode(code)).toEqual({ ok: false });
  });

  it("allows the right code on the last permitted attempt", async () => {
    const { code } = await issue();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < config.otp.maxAttempts - 1; i++) await verifyCode(wrong);
    expect((await verifyCode(code)).ok).toBe(true);
  });

  it("a new request replaces the old challenge and resets attempts", async () => {
    const first = await issue();
    const wrong = first.code === "000000" ? "111111" : "000000";
    for (let i = 0; i < config.otp.maxAttempts; i++) await verifyCode(wrong);
    const second = await issue();
    expect((await verifyCode(second.code)).ok).toBe(true);
  });

  it("the magic link works once and shares the attempt limit", async () => {
    const { linkToken } = await issue();
    const secret = linkToken.split(".")[1]!;
    expect(
      await verifyChallenge(store, PEPPER, HASH, { linkSecret: "wrong" }, config, clock.now()),
    ).toEqual({ ok: false });
    expect(
      (await verifyChallenge(store, PEPPER, HASH, { linkSecret: secret }, config, clock.now())).ok,
    ).toBe(true);
    expect(
      (await verifyChallenge(store, PEPPER, HASH, { linkSecret: secret }, config, clock.now())).ok,
    ).toBe(false);
  });

  it("a missing challenge is the same failure", async () => {
    expect(await verifyCode("123456")).toEqual({ ok: false });
  });

  it("concurrent guesses never exceed the attempt limit and a correct code wins at most once", async () => {
    const { code } = await issue();
    const wrong = code === "000000" ? "111111" : "000000";
    await Promise.all(Array.from({ length: 30 }, () => verifyCode(wrong)));
    const stored = JSON.parse((await store.get(keys.otp(HASH)))!.body) as { attempts: number };
    expect(stored.attempts).toBeLessThanOrEqual(config.otp.maxAttempts);
    expect(await verifyCode(code)).toEqual({ ok: false });
  });

  it("concurrent correct codes: exactly one succeeds", async () => {
    const { code } = await issue();
    const results = await Promise.all(Array.from({ length: 20 }, () => verifyCode(code)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});
