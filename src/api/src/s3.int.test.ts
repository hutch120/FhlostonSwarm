import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getCredits, grantCredits } from "./credits.js";
import { emailHash, parseEmail } from "./identity.js";
import { issueChallenge, verifyChallenge } from "./otp.js";
import { createSession, rotateSession } from "./sessions.js";
import { createHarness, testConfig, testSecrets } from "./testkit.js";
import { hit } from "./ratelimit.js";
import { createJson, getJson, updateJson } from "./storage/json.js";
import { keys } from "./storage/keys.js";
import { PrefixedStore, S3ObjectStore } from "./storage/store.js";
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
  it("conditional create: 50 concurrent creates of one key, exactly one succeeds", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => createJson(store, "create/once.json", { at: Date.now() })),
    );
    expect(results.filter((won) => won)).toHaveLength(1);
    expect(results.filter((won) => !won)).toHaveLength(49);
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

  describe("intake, credits and deletion", () => {
    const EMAIL = "swarm-test-intake-int@example.com";
    const emailKey = emailHash(testSecrets.pepper, parseEmail(EMAIL)!);
    const target = {
      appUrl: "https://staging.example.com",
      logins: { user1: { username: "swarm-test-u", password: "p", description: "Standard" } },
      acknowledged: true,
    };
    const scan = (targetId: string) => ({
      targetId,
      name: "Integration sweep",
      tier: "sweep",
      frequency: "once",
      timezone: "UTC",
      notifyEmail: EMAIL,
      notifyOn: "never",
      loginSlots: ["user1"],
    });

    it("with one credit, fifty concurrent starts create exactly one run and spend the credit once", async () => {
      const h = createHarness({ store });
      const b = h.browser();
      await h.signIn(b, EMAIL);
      await grantCredits(
        store,
        emailKey,
        { tier: "sweep", count: 1, source: "comp", reason: "integration test", by: "test" },
        Date.now(),
        true,
      );
      const { id: targetId } = (await (
        await b.withCsrf("POST", "/api/targets", target)
      ).json()) as { id: string };
      const { id: scanId } = (await (
        await b.withCsrf("POST", "/api/scans", scan(targetId))
      ).json()) as { id: string };

      const results = await Promise.all(
        Array.from({ length: 50 }, () => b.withCsrf("POST", `/api/scans/${scanId}/run`)),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 402)).toHaveLength(49);
      expect(await getCredits(store, emailKey)).toMatchObject({ sweep: 0 });
      const runs = (await store.list(keys.runsPrefix(emailKey))).filter((k) =>
        k.endsWith("/summary.json"),
      );
      expect(runs).toHaveLength(1);

      // A Scout credit cannot start a Sweep scan.
      await grantCredits(
        store,
        emailKey,
        { tier: "scout", count: 3, source: "comp", reason: "integration test", by: "test" },
        Date.now(),
        true,
      );
      expect((await b.withCsrf("POST", `/api/scans/${scanId}/run`)).status).toBe(402);
    }, 120_000);

    it("deleting the account leaves nothing under the user's prefix, and another user's data is untouched", async () => {
      const h = createHarness({ store });
      const owner = h.browser();
      await h.signIn(owner, EMAIL);
      const otherEmail = "swarm-test-intake-int-b@example.com";
      const other = h.browser("198.51.100.77");
      await h.signIn(other, otherEmail);
      const otherKey = emailHash(testSecrets.pepper, parseEmail(otherEmail)!);

      for (const [b, address, key] of [
        [owner, EMAIL, emailKey],
        [other, otherEmail, otherKey],
      ] as const) {
        await grantCredits(
          store,
          key,
          { tier: "sweep", count: 2, source: "comp", reason: "integration test", by: "test" },
          Date.now(),
          true,
        );
        const { id: targetId } = (await (
          await b.withCsrf("POST", "/api/targets", target)
        ).json()) as { id: string };
        const { id: scanId } = (await (
          await b.withCsrf("POST", "/api/scans", {
            ...scan(targetId),
            notifyEmail: "team@example.org",
            notifyOn: "always",
          })
        ).json()) as { id: string };
        expect((await b.withCsrf("POST", `/api/scans/${scanId}/run`)).status, address).toBe(201);
      }
      const before = await store.list(keys.userPrefix(otherKey));
      expect((await store.list(keys.userPrefix(emailKey))).length).toBeGreaterThan(6);

      // Another user cannot reach the owner's scan.
      const { id: ownerScan } = (
        (await (await owner.request("GET", "/api/scans")).json()) as { id: string }[]
      )[0]!;
      expect((await other.request("GET", `/api/scans/${ownerScan}`)).status).toBe(404);

      await owner.withCsrf("POST", "/api/account/delete-code");
      const { code } = h.mailer.lastDeletionCodeTo(EMAIL)!;
      expect((await owner.withCsrf("DELETE", "/api/account", { code })).status).toBe(200);

      expect(await store.list(keys.userPrefix(emailKey))).toEqual([]);
      expect(await store.get(keys.otp(emailKey))).toBeNull();
      expect(await store.list(keys.emailRateLimits(emailKey))).toEqual([]);
      expect(await store.list(keys.userPrefix(otherKey))).toEqual(before);
    }, 120_000);
  });
});
