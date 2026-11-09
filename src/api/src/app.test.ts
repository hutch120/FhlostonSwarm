import { describe, expect, it, vi } from "vitest";
import { emailHash, parseEmail } from "./identity.js";
import { keys } from "./storage/keys.js";
import { createHarness, failingMailer, SITE, testConfig, testSecrets } from "./testkit.js";

const hashOf = (address: string) => emailHash(testSecrets.pepper, parseEmail(address)!);
const sessionBody = async (res: Response) =>
  (await res.json()) as {
    authenticated?: boolean;
    user?: { email: string; role: string };
    csrfToken?: string;
  };

describe("health and headers", () => {
  it("answers /api/health with security headers and no caching", async () => {
    const h = createHarness();
    const res = await h.browser().request("GET", "/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("strict-transport-security")).toMatch(/max-age=\d+/);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns JSON 404s for unknown routes", async () => {
    const res = await createHarness().browser().request("GET", "/api/nope");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/auth/request", () => {
  it("sends a code and a magic link, and answers { ok: true }", async () => {
    const h = createHarness();
    const res = await h
      .browser()
      .request("POST", "/api/auth/request", { email: "Buyer@Example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const mail = h.mailer.lastTo("buyer@example.com")!;
    expect(mail.code).toMatch(/^\d{6}$/);
    expect(mail.link).toMatch(new RegExp(`^${SITE}/auth/verify\\?token=[0-9a-f]{64}\\.`));
  });

  it("stores no plaintext code or email in the challenge object", async () => {
    const h = createHarness();
    const code = await h.codeFor(h.browser(), "buyer@example.com");
    const stored = (await h.store.get(keys.otp(hashOf("buyer@example.com"))))!.body;
    expect(stored).not.toContain(code);
  });

  it("gives an identical response for sent, disposable, suppressed and throttled addresses", async () => {
    const h = createHarness();
    await h.store.put(keys.suppression(hashOf("bounced@example.com")), "{}");
    const answers = [];
    for (const email of ["new@example.com", "x@mailinator.com", "bounced@example.com"]) {
      const res = await h.browser().request("POST", "/api/auth/request", { email });
      answers.push([res.status, await res.text()]);
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(h.mailer.sent.map((m) => m.to)).toEqual(["new@example.com"]);
  });

  it("silently stops sending after the per-email limit, with the same response", async () => {
    const h = createHarness();
    const limit = testConfig().rateLimits.requestPerEmailPerHour;
    const statuses = new Set<string>();
    for (let i = 0; i < limit + 3; i++) {
      const res = await h
        .browser(`198.51.100.${i}`)
        .request("POST", "/api/auth/request", { email: "busy@example.com" });
      statuses.add(`${res.status} ${await res.text()}`);
    }
    expect(statuses.size).toBe(1);
    expect(h.mailer.sent).toHaveLength(limit);
  });

  it("limits by IP with 429", async () => {
    const h = createHarness();
    const limit = testConfig().rateLimits.requestPerIpPerHour;
    const b = h.browser("192.0.2.9");
    let last = 200;
    for (let i = 0; i <= limit; i++) {
      last = (await b.request("POST", "/api/auth/request", { email: `u${i}@example.com` })).status;
    }
    expect(last).toBe(429);
  });

  it("applies the same minimum duration whether or not mail is sent", async () => {
    const sleeps: number[] = [];
    const h = createHarness({
      config: testConfig({ minRequestMs: 800 }),
      sleep: async (ms) => void sleeps.push(ms),
    });
    await h.browser().request("POST", "/api/auth/request", { email: "new@example.com" });
    await h.browser().request("POST", "/api/auth/request", { email: "x@mailinator.com" });
    expect(sleeps).toHaveLength(2);
    expect(sleeps.every((ms) => ms > 0 && ms <= 800)).toBe(true);
  });

  it("rejects malformed input with 400", async () => {
    const h = createHarness();
    const b = h.browser();
    expect((await b.request("POST", "/api/auth/request", { email: "nope" })).status).toBe(400);
    expect((await b.request("POST", "/api/auth/request", {})).status).toBe(400);
    expect((await b.request("POST", "/api/auth/request", { email: 5 })).status).toBe(400);
    expect(
      (
        await b.request("POST", "/api/auth/request", undefined, {
          "content-type": "application/json",
        })
      ).status,
    ).toBe(400);
  });

  it("still answers ok when the mailer fails", async () => {
    const h = createHarness({ mailer: failingMailer });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await h
      .browser()
      .request("POST", "/api/auth/request", { email: "new@example.com" });
    expect(res.status).toBe(200);
  });

  it("enforces the optional human check", async () => {
    const h = createHarness({ verifyHuman: async (token) => token === "good" });
    const b = h.browser();
    expect((await b.request("POST", "/api/auth/request", { email: "a@example.com" })).status).toBe(
      400,
    );
    expect(
      (
        await b.request("POST", "/api/auth/request", {
          email: "a@example.com",
          turnstileToken: "good",
        })
      ).status,
    ).toBe(200);
  });
});

describe("sign in, session and sign out", () => {
  it("signs in with the emailed code, sets hardened cookies, and creates the profile", async () => {
    const h = createHarness();
    const b = h.browser();
    const res = await h.signIn(b, "Buyer@Example.com");
    expect(res.status).toBe(200);
    const body = await sessionBody(res);
    expect(body.user).toEqual({ email: "buyer@example.com", role: "customer" });
    expect(body.csrfToken).toBeTruthy();

    const cookies = res.headers.getSetCookie();
    const access = cookies.find((c) => c.startsWith("__Host-swarm_at="))!;
    const refresh = cookies.find((c) => c.startsWith("__Secure-swarm_rt="))!;
    for (const cookie of [access, refresh]) {
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/Secure/i);
      expect(cookie).toMatch(/SameSite=(Lax|Strict)/i);
    }
    expect(access).toMatch(/Path=\//);
    expect(access).toMatch(/SameSite=Lax/i);
    expect(refresh).toMatch(/Path=\/api\/auth/);

    const profile = JSON.parse(
      (await h.store.get(keys.profile(hashOf("buyer@example.com"))))!.body,
    );
    expect(profile).toMatchObject({ email: "buyer@example.com", role: "customer" });
  });

  it("signs in with the magic link token", async () => {
    const h = createHarness();
    const b = h.browser();
    await b.request("POST", "/api/auth/request", { email: "buyer@example.com" });
    const token = new URL(h.mailer.lastTo("buyer@example.com")!.link).searchParams.get("token")!;
    const res = await b.request("POST", "/api/auth/verify", { token });
    expect(res.status).toBe(200);
    expect((await b.request("POST", "/api/auth/verify", { token })).status).toBe(401);
  });

  it("a session persists: /api/auth/session and /api/me work with the cookies", async () => {
    const h = createHarness();
    const b = h.browser();
    await h.signIn(b, "buyer@example.com");
    const session = await sessionBody(await b.request("GET", "/api/auth/session"));
    expect(session).toMatchObject({ authenticated: true, user: { email: "buyer@example.com" } });
    expect(session.csrfToken).toBe(b.csrf);
    const me = await (await b.request("GET", "/api/me")).json();
    expect(me).toEqual({
      email: "buyer@example.com",
      role: "customer",
      entitlements: { credits: { scout: 0, sweep: 0, probe: 0, siege: 0 }, unmetered: false },
    });
  });

  it("marks every record for a swarm-test- identity as test data, and no others", async () => {
    const h = createHarness();
    await h.signIn(h.browser(), "swarm-test-e2e@example.com");
    await h.signIn(h.browser(), "buyer@example.com");
    const test = hashOf("swarm-test-e2e@example.com");
    const real = hashOf("buyer@example.com");
    const marked = async (key: string) => JSON.parse((await h.store.get(key))!.body).test;
    expect(await marked(keys.profile(test))).toBe(true);
    expect(await marked(keys.profile(real))).toBeUndefined();
    for (const key of await h.store.list(keys.sessionsPrefix(test)))
      expect(await marked(key)).toBe(true);
    for (const key of await h.store.list(keys.sessionsPrefix(real)))
      expect(await marked(key)).toBeUndefined();
    // The marker survives refresh-token rotation.
    const b = h.browser();
    await h.signIn(b, "swarm-test-e2e@example.com");
    await b.request("POST", "/api/auth/refresh", {});
    for (const key of await h.store.list(keys.sessionsPrefix(test)))
      expect(await marked(key)).toBe(true);
  });

  it("answers 401 on /api/me without a session", async () => {
    expect((await createHarness().browser().request("GET", "/api/me")).status).toBe(401);
  });

  it("renews an expired access token from the refresh cookie on /api/auth/session", async () => {
    const h = createHarness();
    const b = h.browser();
    await h.signIn(b, "buyer@example.com");
    const before = b.cookie("__Secure-swarm_rt");
    h.clock.advance(testConfig().session.accessTtlMinutes * 60_000 + 5_000);
    expect((await b.request("GET", "/api/me")).status).toBe(401);
    const session = await sessionBody(await b.request("GET", "/api/auth/session"));
    expect(session.authenticated).toBe(true);
    expect(b.cookie("__Secure-swarm_rt")).not.toBe(before);
    expect((await b.request("GET", "/api/me")).status).toBe(200);
  });

  it("POST /api/auth/refresh rotates the refresh token", async () => {
    const h = createHarness();
    const b = h.browser();
    await h.signIn(b, "buyer@example.com");
    const old = b.cookie("__Secure-swarm_rt")!;
    expect((await b.request("POST", "/api/auth/refresh", {})).status).toBe(200);
    expect(b.cookie("__Secure-swarm_rt")).not.toBe(old);

    // Replaying the old refresh token fails and kills the session.
    const thief = h.browser();
    await thief.request("GET", "/api/health");
    const replay = await thief.request(
      "POST",
      "/api/auth/refresh",
      {},
      { cookie: `__Secure-swarm_rt=${old}` },
    );
    expect(replay.status).toBe(401);
    expect((await b.request("GET", "/api/me")).status).toBe(401);
  });

  it("does not send the refresh cookie to non-auth paths", async () => {
    const h = createHarness();
    const b = h.browser();
    await h.signIn(b, "buyer@example.com");
    expect(b.names().sort()).toEqual(["__Host-swarm_at", "__Secure-swarm_rt"]);
  });

  it("logout clears the cookies AND revokes the refresh token server-side", async () => {
    const h = createHarness();
    const b = h.browser();
    await h.signIn(b, "buyer@example.com");
    const refresh = b.cookie("__Secure-swarm_rt")!;
    const access = b.cookie("__Host-swarm_at")!;

    const out = await b.withCsrf("POST", "/api/auth/logout", {});
    expect(out.status).toBe(200);
    expect(b.names()).toEqual([]);

    // Replaying the stolen cookies after logout fails.
    const attacker = h.browser();
    expect(
      (
        await attacker.request(
          "POST",
          "/api/auth/refresh",
          {},
          { cookie: `__Secure-swarm_rt=${refresh}` },
        )
      ).status,
    ).toBe(401);
    expect(
      (await attacker.request("GET", "/api/me", undefined, { cookie: `__Host-swarm_at=${access}` }))
        .status,
    ).toBe(401);
  });

  it("logout without the CSRF token is refused and changes nothing", async () => {
    const h = createHarness();
    const b = h.browser();
    await h.signIn(b, "buyer@example.com");
    expect((await b.request("POST", "/api/auth/logout", {})).status).toBe(403);
    expect(
      (await b.request("POST", "/api/auth/logout", {}, { "x-csrf-token": "wrong" })).status,
    ).toBe(403);
    expect((await b.request("GET", "/api/me")).status).toBe(200);
  });

  it("logout with no session is harmless", async () => {
    expect((await createHarness().browser().request("POST", "/api/auth/logout", {})).status).toBe(
      200,
    );
  });
});

describe("verification failures", () => {
  it("rejects a wrong code, and locks after 5 wrong codes even for the right one", async () => {
    const h = createHarness();
    const b = h.browser();
    const code = await h.codeFor(b, "buyer@example.com");
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      const res = await b.request("POST", "/api/auth/verify", {
        email: "buyer@example.com",
        code: wrong,
      });
      expect(res.status).toBe(401);
    }
    const res = await b.request("POST", "/api/auth/verify", { email: "buyer@example.com", code });
    expect(res.status).toBe(401);
    expect(b.names()).toEqual([]);
  });

  it("rejects an expired code", async () => {
    const h = createHarness();
    const b = h.browser();
    const code = await h.codeFor(b, "buyer@example.com");
    h.clock.advance(11 * 60_000);
    expect(
      (await b.request("POST", "/api/auth/verify", { email: "buyer@example.com", code })).status,
    ).toBe(401);
  });

  it("answers the same for an address that never requested a code", async () => {
    const h = createHarness();
    const b = h.browser();
    const unknown = await b.request("POST", "/api/auth/verify", {
      email: "ghost@example.com",
      code: "123456",
    });
    const code = await h.codeFor(b, "real@example.com");
    const wrong = await b.request("POST", "/api/auth/verify", {
      email: "real@example.com",
      code: code === "000000" ? "111111" : "000000",
    });
    expect([unknown.status, await unknown.text()]).toEqual([wrong.status, await wrong.text()]);
  });

  it("rejects malformed bodies and a code that is the wrong length", async () => {
    const h = createHarness();
    const b = h.browser();
    expect((await b.request("POST", "/api/auth/verify", { email: "a@example.com" })).status).toBe(
      400,
    );
    expect(
      (await b.request("POST", "/api/auth/verify", { email: "a@example.com", code: "12" })).status,
    ).toBe(400);
    expect(
      (await b.request("POST", "/api/auth/verify", { email: "a@example.com", code: "1234567" }))
        .status,
    ).toBe(401);
    expect((await b.request("POST", "/api/auth/verify", { token: "nope" })).status).toBe(401);
  });

  it("limits verify attempts per IP", async () => {
    const h = createHarness();
    const b = h.browser("192.0.2.77");
    const limit = testConfig().rateLimits.verifyPerIpPerHour;
    let last = 0;
    for (let i = 0; i <= limit; i++) {
      last = (
        await b.request("POST", "/api/auth/verify", { email: "a@example.com", code: "123456" })
      ).status;
    }
    expect(last).toBe(429);
  });
});

describe("CSRF and request hygiene", () => {
  it("refuses mutating requests from another origin or with no origin", async () => {
    const h = createHarness();
    const b = h.browser();
    for (const headers of [{ origin: "https://evil.example" }, { origin: "null" }]) {
      expect(
        (await b.request("POST", "/api/auth/request", { email: "a@example.com" }, headers)).status,
      ).toBe(403);
    }
    const res = await h.app.request("/api/auth/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@example.com" }),
    });
    expect(res.status).toBe(403);
    expect(h.mailer.sent).toHaveLength(0);
  });

  it("refuses non-JSON bodies (form posts cannot be forged cross-site)", async () => {
    const h = createHarness();
    const res = await h.browser().request("POST", "/api/auth/request", undefined, {
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(res.status).toBe(415);
  });
});

describe("staff role", () => {
  it("a Gmail account cannot reach /api/staff/* (403)", async () => {
    const h = createHarness();
    const b = h.browser();
    await h.signIn(b, "buyer@gmail.com");
    expect((await b.request("GET", "/api/staff/whoami")).status).toBe(403);
  });

  it("a personal mailbox on the staff domain can, and is staff in the session", async () => {
    const h = createHarness();
    const b = h.browser();
    const res = await h.signIn(b, "swarm-test-e2e@fhlostonswarm.com");
    expect((await sessionBody(res)).user?.role).toBe("staff");
    const who = await b.request("GET", "/api/staff/whoami");
    expect(who.status).toBe(200);
    expect(await who.json()).toEqual({ email: "swarm-test-e2e@fhlostonswarm.com", role: "staff" });
  });

  it("the shared support@ address cannot (403), nor can a lookalike domain", async () => {
    const h = createHarness();
    for (const email of [
      "support@fhlostonswarm.com",
      "login@fhlostonswarm.com",
      "sam@fhlostonswarm.com.evil.test",
    ]) {
      const b = h.browser();
      await h.signIn(b, email);
      expect((await b.request("GET", "/api/staff/whoami")).status, email).toBe(403);
    }
  });

  it("is 401 with no session", async () => {
    expect((await createHarness().browser().request("GET", "/api/staff/whoami")).status).toBe(401);
  });
});

describe("entitlements", () => {
  it("/api/me reports zero credits per scan depth for a new account", async () => {
    const h = createHarness();
    const b = h.browser();
    await h.signIn(b, "buyer@example.com");
    const me = (await (await b.request("GET", "/api/me")).json()) as {
      entitlements: { credits: Record<string, number> };
    };
    expect(me.entitlements.credits).toEqual({ scout: 0, sweep: 0, probe: 0, siege: 0 });
  });
});
