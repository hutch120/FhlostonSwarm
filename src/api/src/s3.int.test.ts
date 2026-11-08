import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { issueChallenge, verifyChallenge } from "./otp.js";
import { createSession, rotateSession } from "./sessions.js";
import { createHarness, testConfig, testSecrets } from "./testkit.js";
import { hit } from "./ratelimit.js";
import { getJson, updateJson } from "./storage/json.js";
import { keys } from "./storage/keys.js";
import { PrefixedStore, S3ObjectStore } from "./storage/store.js";
import { claimFreeReport } from "./users.js";
import { z } from "zod";

/**
 * Real-S3 integration tests. They run only with SWARM_INTEGRATION=1 (`npm run test:integration`,
 * which also selects the `swarm` AWS profile) and write only under _test/<runId>/, removed after.
 */
const enabled = process.env["SWARM_INTEGRATION"] === "1";
const BUCKET = "swarm-data-885922397779";

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const runId = `${stamp.slice(0, 8)}-${stamp.slice(8)}-${randomBytes(3).toString("hex")}`;
const raw = new S3ObjectStore(BUCKET);
const store = new PrefixedStore(raw, `_test/${runId}/`);
const config = testConfig();

afterAll(async () => {
  if (!enabled) return;
  for (const key of await raw.list(`_test/${runId}/`)) await raw.delete(key);
  expect(await raw.list(`_test/${runId}/`)).toEqual([]);
});

describe.skipIf(!enabled)("S3 integration (_test/ prefix)", () => {
  it("conditional create: 50 concurrent free claims, exactly one succeeds", async () => {
    const hash = "d".repeat(64);
    const results = await Promise.all(
      Array.from({ length: 50 }, () => claimFreeReport(store, hash, Date.now())),
    );
    expect(results.filter((r) => r === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r === "already-claimed")).toHaveLength(49);
  }, 60_000);

  it("compare-and-swap counters do not lose updates", async () => {
    const counter = z.object({ n: z.number() });
    await Promise.all(
      Array.from({ length: 10 }, () =>
        updateJson(store, "cas/counter.json", counter, (c) => ({ n: (c?.n ?? 0) + 1 }), {
          retries: 60,
        }),
      ),
    );
    expect((await getJson(store, "cas/counter.json", counter))?.value.n).toBe(10);
  }, 60_000);

  it("concurrent OTP attempts never exceed the limit and a correct code wins once", async () => {
    const hash = "e".repeat(64);
    const { code } = await issueChallenge(
      store,
      testSecrets.pepper,
      hash,
      "t@example.com",
      config,
      Date.now(),
    );
    const wrong = code === "000000" ? "111111" : "000000";
    await Promise.all(
      Array.from({ length: 12 }, () =>
        verifyChallenge(store, testSecrets.pepper, hash, { code: wrong }, config, Date.now()),
      ),
    );
    const stored = JSON.parse((await store.get(keys.otp(hash)))!.body) as { attempts: number };
    expect(stored.attempts).toBeLessThanOrEqual(config.otp.maxAttempts);
    expect(
      (await verifyChallenge(store, testSecrets.pepper, hash, { code }, config, Date.now())).ok,
    ).toBe(false);

    const fresh = await issueChallenge(
      store,
      testSecrets.pepper,
      hash,
      "t@example.com",
      config,
      Date.now(),
    );
    const wins = await Promise.all(
      Array.from({ length: 8 }, () =>
        verifyChallenge(store, testSecrets.pepper, hash, { code: fresh.code }, config, Date.now()),
      ),
    );
    expect(wins.filter((r) => r.ok)).toHaveLength(1);
  }, 60_000);

  it("refresh-token rotation invalidates the old token", async () => {
    const issued = await createSession(
      store,
      testSecrets,
      { emailHash: "f".repeat(64), email: "t@example.com", role: "customer" },
      config,
      Date.now(),
    );
    const next = await rotateSession(store, testSecrets, issued.refreshToken, config, Date.now());
    expect(next).not.toBeNull();
    expect(
      await rotateSession(store, testSecrets, issued.refreshToken, config, Date.now()),
    ).toBeNull();
    expect(
      await rotateSession(store, testSecrets, next!.refreshToken, config, Date.now()),
    ).toBeNull();
  }, 60_000);

  it("rate-limit windows count and stop at the limit", async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await hit(store, "ip-test-request", 3, Date.now()));
    expect(results).toEqual([true, true, true, false]);
  }, 60_000);

  it("the whole sign-in flow works against S3", async () => {
    const h = createHarness({ store });
    const b = h.browser();
    const res = await h.signIn(b, "swarm-test-integration@example.com");
    expect(res.status).toBe(200);
    expect((await b.request("GET", "/api/me")).status).toBe(200);
    expect((await b.withCsrf("POST", "/api/auth/logout", {})).status).toBe(200);
    expect((await b.request("GET", "/api/me")).status).toBe(401);
  }, 60_000);
});
