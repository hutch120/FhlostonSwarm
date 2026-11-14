import { beforeEach, describe, expect, it, vi } from "vitest";
import { grantCredits } from "./credits.js";
import { emailHash, parseEmail } from "./identity.js";
import { keys } from "./storage/keys.js";
import { createHarness, testSecrets, type Harness, type TestBrowser } from "./testkit.js";

const hashOf = (address: string) => emailHash(testSecrets.pepper, parseEmail(address)!);

const OWNER = "swarm-test-owner@example.com";
const OTHER = "swarm-test-other@example.com";
const PASSWORD = "not-a-real-password-owner-1";

const targetBody = (over: Record<string, unknown> = {}) => ({
  appUrl: "https://staging.example.com",
  marketingUrl: "",
  scopeNotes: "Do not touch /billing",
  logins: {
    user1: { username: "swarm-test-user1", password: PASSWORD, description: "Standard customer" },
  },
  acknowledged: true,
  ...over,
});

const scanBody = (targetId: string, over: Record<string, unknown> = {}) => ({
  targetId,
  name: "Weekly sweep",
  tier: "sweep",
  frequency: "weekly",
  timezone: "Australia/Sydney",
  notifyEmail: OWNER,
  notifyOn: "always",
  loginSlots: ["user1"],
  ...over,
});

interface Ctx {
  h: Harness;
  owner: TestBrowser;
}

const ids = {
  target: async (res: Response) => ((await res.json()) as { id: string }).id,
  run: async (res: Response) => ((await res.json()) as { runId: string }).runId,
};

async function signedIn(h: Harness, email = OWNER) {
  const browser = h.browser();
  await h.signIn(browser, email);
  return browser;
}

const grant = (h: Harness, email: string, tier: "scout" | "sweep" | "probe" | "siege", count = 1) =>
  grantCredits(
    h.store,
    hashOf(email),
    { tier, count, source: "comp", reason: "test", by: "tester" },
    h.clock.now(),
  );

async function newTarget(b: TestBrowser, over: Record<string, unknown> = {}) {
  const res = await b.withCsrf("POST", "/api/targets", targetBody(over));
  expect(res.status).toBe(201);
  return ids.target(res);
}

async function newScan(b: TestBrowser, targetId: string, over: Record<string, unknown> = {}) {
  const res = await b.withCsrf("POST", "/api/scans", scanBody(targetId, over));
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

let ctx: Ctx;
beforeEach(async () => {
  const h = createHarness();
  ctx = { h, owner: await signedIn(h) };
});

const storedJson = async (key: string) => JSON.parse((await ctx.h.store.get(key))!.body);

describe("targets", () => {
  it("saves a target without returning the password, and records the acknowledgement", async () => {
    const { h, owner } = ctx;
    const res = await owner.withCsrf(
      "POST",
      "/api/targets",
      targetBody({ marketingUrl: "https://www.example.com" }),
    );
    expect(res.status).toBe(201);
    const body = await res.text();
    expect(body).not.toContain(PASSWORD);
    const view = JSON.parse(body);
    expect(view).toMatchObject({
      appUrl: "https://staging.example.com",
      hosts: ["staging.example.com", "www.example.com"],
      logins: { user1: { username: "swarm-test-user1", passwordSaved: true } },
      scans: [],
    });

    const stored = await storedJson(keys.target(hashOf(OWNER), view.id));
    expect(stored.logins.user1.password).toBe(PASSWORD);
    expect(stored.test).toBe(true);
    expect(stored.acknowledgement).toMatchObject({
      ip: "203.0.113.7",
      termsVersion: expect.any(String),
    });
    expect(typeof stored.acknowledgement.at).toBe("number");

    expect(await (await owner.request("GET", "/api/targets")).text()).not.toContain(PASSWORD);
    expect(h.mailer.sent).toHaveLength(1);
  });

  it("refuses unsafe or invalid URLs with a code that names the field", async () => {
    const { owner } = ctx;
    const cases: [Record<string, unknown>, string][] = [
      [{ appUrl: "ftp://example.com" }, "app_url_invalid_url"],
      [{ appUrl: "https://user:pw@example.com" }, "app_url_credentials_in_url"],
      [{ appUrl: "http://169.254.169.254/latest" }, "app_url_private_address"],
      [{ appUrl: "http://10.0.0.5" }, "app_url_private_address"],
      [{ appUrl: "http://localhost:3000" }, "app_url_unroutable_host"],
      [{ appUrl: "https://app.fhlostonswarm.com" }, "app_url_blocked_host"],
      [{ marketingUrl: "https://www.example.gov.au" }, "marketing_url_blocked_host"],
      [{ marketingUrl: "not a url" }, "marketing_url_invalid_url"],
    ];
    for (const [over, code] of cases) {
      const res = await owner.withCsrf("POST", "/api/targets", targetBody(over));
      expect(res.status, code).toBe(400);
      expect(await res.json()).toEqual({ error: code });
    }
    expect(await (await owner.request("GET", "/api/targets")).json()).toEqual([]);
  });

  it("lets staff target our own domain, and a customer cannot", async () => {
    const { h, owner } = ctx;
    const staff = await signedIn(h, "swarm-test-staff3@fhlostonswarm.com");
    const own = { appUrl: "https://app.fhlostonswarm.com" };
    const created = await staff.withCsrf("POST", "/api/targets", targetBody(own));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ hosts: ["app.fhlostonswarm.com"] });
    const res = await staff.withCsrf(
      "POST",
      "/api/targets",
      targetBody({ appUrl: "https://mail.google.com" }),
    );
    expect(await res.json()).toEqual({ error: "app_url_blocked_host" });
    expect((await owner.withCsrf("POST", "/api/targets", targetBody(own))).status).toBe(400);
  });

  it("needs the authorisation acknowledgement and a password for each new login", async () => {
    const { owner } = ctx;
    expect(
      (await owner.withCsrf("POST", "/api/targets", targetBody({ acknowledged: false }))).status,
    ).toBe(400);
    expect(
      (await owner.withCsrf("POST", "/api/targets", targetBody({ acknowledged: undefined })))
        .status,
    ).toBe(400);
    const noPassword = await owner.withCsrf(
      "POST",
      "/api/targets",
      targetBody({ logins: { user1: { username: "u", description: "d" } } }),
    );
    expect(await noPassword.json()).toEqual({ error: "password_required" });
    expect(
      (
        await owner.withCsrf(
          "POST",
          "/api/targets",
          targetBody({ logins: { root: { username: "u", password: "p", description: "d" } } }),
        )
      ).status,
    ).toBe(400);
  });

  it("keeps the saved password when an update leaves it out, and replaces it when one is sent", async () => {
    const { owner } = ctx;
    const id = await newTarget(owner);
    const key = keys.target(hashOf(OWNER), id);

    const keep = await owner.withCsrf(
      "PUT",
      `/api/targets/${id}`,
      targetBody({ logins: { user1: { username: "renamed", description: "Standard customer" } } }),
    );
    expect(keep.status).toBe(200);
    expect((await storedJson(key)).logins.user1).toMatchObject({
      username: "renamed",
      password: PASSWORD,
    });

    const replace = await owner.withCsrf(
      "PUT",
      `/api/targets/${id}`,
      targetBody({
        logins: { user1: { username: "renamed", password: "second-password", description: "d" } },
      }),
    );
    expect(await replace.text()).not.toContain("second-password");
    expect((await storedJson(key)).logins.user1.password).toBe("second-password");
  });

  it("cannot drop a login that a scan uses, but can drop one that none uses", async () => {
    const { owner } = ctx;
    const id = await newTarget(owner, {
      logins: {
        user1: { username: "a", password: "p1", description: "d" },
        admin: { username: "b", password: "p2", description: "d" },
      },
    });
    await newScan(owner, id);
    const onlyAdmin = targetBody({ logins: { admin: { username: "b", description: "d" } } });
    expect(await (await owner.withCsrf("PUT", `/api/targets/${id}`, onlyAdmin)).json()).toEqual({
      error: "login_in_use",
    });
    const onlyUser = targetBody({ logins: { user1: { username: "a", description: "d" } } });
    expect((await owner.withCsrf("PUT", `/api/targets/${id}`, onlyUser)).status).toBe(200);
  });

  it("deleting a target removes its scans and reports them, but keeps past runs", async () => {
    const { h, owner } = ctx;
    await grant(h, OWNER, "sweep", 1);
    const id = await newTarget(owner);
    const scanId = await newScan(owner, id);
    const runId = await ids.run(await owner.withCsrf("POST", `/api/scans/${scanId}/run`));
    const listed = (await (await owner.request("GET", "/api/targets")).json()) as {
      scans: { id: string }[];
    }[];
    expect(listed[0]!.scans.map((s) => s.id)).toEqual([scanId]);

    const res = await owner.withCsrf("DELETE", `/api/targets/${id}`);
    expect(await res.json()).toEqual({ ok: true, deletedScans: [scanId] });
    expect(await h.store.get(keys.target(hashOf(OWNER), id))).toBeNull();
    expect(await h.store.get(keys.scan(hashOf(OWNER), scanId))).toBeNull();
    const runs = (await (await owner.request("GET", "/api/runs")).json()) as {
      summary: { runId: string };
      scanId?: string;
    }[];
    expect(runs.map((r) => r.summary.runId)).toEqual([runId]);
    expect(runs[0]!.scanId).toBeUndefined();
  });

  it("limits how many targets one account can hold", async () => {
    const { owner } = ctx;
    for (let i = 0; i < 20; i++)
      await newTarget(owner, { appUrl: `https://staging${i}.example.com` });
    const res = await owner.withCsrf("POST", "/api/targets", targetBody());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "quota_exceeded" });
  });

  it("needs a session and the CSRF token", async () => {
    const { h } = ctx;
    expect((await h.browser().request("GET", "/api/targets")).status).toBe(401);
    expect((await ctx.owner.request("POST", "/api/targets", targetBody())).status).toBe(403);
  });
});

describe("scans", () => {
  it("saves a scan with its settings and lists it without credentials", async () => {
    const { owner } = ctx;
    const id = await newTarget(owner);
    const res = await owner.withCsrf("POST", "/api/scans", scanBody(id));
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(PASSWORD);
    expect(JSON.parse(text)).toMatchObject({
      name: "Weekly sweep",
      target: "staging.example.com",
      tier: "sweep",
      frequency: "weekly",
      timezone: "Australia/Sydney",
      notifyEmail: OWNER,
      notifyEmailConfirmed: true,
      status: "active",
      loginSlots: ["user1"],
    });
    const list = await (await owner.request("GET", "/api/scans")).text();
    expect(list).not.toContain(PASSWORD);
    expect(JSON.parse(list)).toHaveLength(1);
  });

  it("fits the number of logins to the depth: Scout 0, Sweep 1, Probe 2, Siege 4", async () => {
    const { owner } = ctx;
    const id = await newTarget(owner, {
      logins: {
        admin: { username: "a", password: "p", description: "d" },
        user1: { username: "b", password: "p", description: "d" },
        user2: { username: "c", password: "p", description: "d" },
        other: { username: "e", password: "p", description: "d" },
      },
    });
    const slots = (n: number) => ["admin", "user1", "user2", "other"].slice(0, n);
    const attempt = async (tier: string, n: number) =>
      (await owner.withCsrf("POST", "/api/scans", scanBody(id, { tier, loginSlots: slots(n) })))
        .status;
    expect(await attempt("scout", 0)).toBe(201);
    expect(await attempt("scout", 1)).toBe(400);
    expect(await attempt("sweep", 0)).toBe(400);
    expect(await attempt("sweep", 1)).toBe(201);
    expect(await attempt("sweep", 2)).toBe(400);
    expect(await attempt("probe", 2)).toBe(201);
    expect(await attempt("probe", 3)).toBe(400);
    expect(await attempt("siege", 4)).toBe(201);
    expect(await attempt("siege", 0)).toBe(400);
    const dupes = await owner.withCsrf(
      "POST",
      "/api/scans",
      scanBody(id, { tier: "probe", loginSlots: ["admin", "admin"] }),
    );
    expect(dupes.status).toBe(400);
  });

  it("one target backs scans of different depths, each using some of its logins", async () => {
    const { owner } = ctx;
    const id = await newTarget(owner, {
      logins: {
        admin: { username: "a", password: "p", description: "d" },
        user1: { username: "b", password: "p", description: "d" },
      },
    });
    await newScan(owner, id, {
      tier: "scout",
      loginSlots: [],
      name: "Daily scout",
      frequency: "daily",
    });
    await newScan(owner, id, { tier: "sweep", loginSlots: ["user1"] });
    await newScan(owner, id, {
      tier: "probe",
      loginSlots: ["admin", "user1"],
      name: "Monthly probe",
      frequency: "monthly",
    });
    expect(((await (await owner.request("GET", "/api/scans")).json()) as unknown[]).length).toBe(3);
  });

  it("refuses a login the target does not hold, an unknown target, a bad zone and a bad tier", async () => {
    const { owner } = ctx;
    const id = await newTarget(owner);
    const fail = async (over: Record<string, unknown>, target = id) =>
      owner.withCsrf("POST", "/api/scans", scanBody(target, over));
    expect(await (await fail({ tier: "probe", loginSlots: ["user1", "admin"] })).json()).toEqual({
      error: "login_missing",
    });
    expect(await (await fail({}, "tgt_doesnotexist1")).json()).toEqual({
      error: "target_not_found",
    });
    expect((await fail({ timezone: "Mars/Olympus" })).status).toBe(400);
    expect((await fail({ tier: "platinum" })).status).toBe(400);
    expect((await fail({ frequency: "hourly" })).status).toBe(400);
    expect((await fail({ notifyEmail: "nope" })).status).toBe(400);
    expect((await fail({ name: "  " })).status).toBe(400);
  });

  it("edits a scan and pauses or resumes it", async () => {
    const { owner } = ctx;
    const id = await newTarget(owner);
    const scanId = await newScan(owner, id);
    const edited = await owner.withCsrf(
      "PUT",
      `/api/scans/${scanId}`,
      scanBody(id, { name: "Renamed", frequency: "monthly" }),
    );
    expect(await edited.json()).toMatchObject({
      id: scanId,
      name: "Renamed",
      frequency: "monthly",
    });
    expect(
      await (
        await owner.withCsrf("PATCH", `/api/scans/${scanId}/status`, { status: "paused" })
      ).json(),
    ).toEqual({ ok: true, status: "paused" });
    expect(await (await owner.request("GET", `/api/scans/${scanId}`)).json()).toMatchObject({
      status: "paused",
    });
    // Editing keeps the pause.
    await owner.withCsrf("PUT", `/api/scans/${scanId}`, scanBody(id, { name: "Renamed again" }));
    expect(await (await owner.request("GET", `/api/scans/${scanId}`)).json()).toMatchObject({
      status: "paused",
    });
    expect(
      (await owner.withCsrf("PATCH", `/api/scans/${scanId}/status`, { status: "gone" })).status,
    ).toBe(400);
  });

  it("deleting a scan removes only that scan", async () => {
    const { h, owner } = ctx;
    await grant(h, OWNER, "sweep", 1);
    const id = await newTarget(owner);
    const keepId = await newScan(owner, id, { name: "Keep" });
    const dropId = await newScan(owner, id, { name: "Drop" });
    const runId = await ids.run(await owner.withCsrf("POST", `/api/scans/${dropId}/run`));
    expect((await owner.withCsrf("DELETE", `/api/scans/${dropId}`)).status).toBe(200);
    const scans = (await (await owner.request("GET", "/api/scans")).json()) as { id: string }[];
    expect(scans.map((s) => s.id)).toEqual([keepId]);
    expect(await h.store.get(keys.target(hashOf(OWNER), id))).not.toBeNull();
    expect(await h.store.get(keys.runSummary(hashOf(OWNER), runId))).not.toBeNull();
    expect((await owner.withCsrf("DELETE", `/api/scans/${dropId}`)).status).toBe(404);
  });

  it("reports the last run on the scan", async () => {
    const { h, owner } = ctx;
    await grant(h, OWNER, "sweep", 1);
    const id = await newTarget(owner);
    const scanId = await newScan(owner, id);
    const runId = await ids.run(await owner.withCsrf("POST", `/api/scans/${scanId}/run`));
    expect(await (await owner.request("GET", `/api/scans/${scanId}`)).json()).toMatchObject({
      lastRun: { runId, status: "queued" },
    });
  });
});

describe("credits and runs", () => {
  it("a new account has no credits and cannot start a run: nothing is written", async () => {
    const { h, owner } = ctx;
    const scanId = await newScan(owner, await newTarget(owner));
    const before = await h.store.list(`users/${hashOf(OWNER)}/`);
    const res = await owner.withCsrf("POST", `/api/scans/${scanId}/run`);
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "no_credit" });
    expect(await h.store.list(`users/${hashOf(OWNER)}/`)).toEqual(before);
    expect(await (await owner.request("GET", "/api/runs")).json()).toEqual([]);
  });

  it("spends one credit of the scan's depth and snapshots the target and scan", async () => {
    const { h, owner } = ctx;
    await grant(h, OWNER, "sweep", 2);
    const id = await newTarget(owner, { marketingUrl: "https://www.example.com" });
    const scanId = await newScan(owner, id, { notifyEmail: "Team@Example.com" });
    const res = await owner.withCsrf("POST", `/api/scans/${scanId}/run`);
    expect(res.status).toBe(201);
    const runId = await ids.run(res);

    const me = (await (await owner.request("GET", "/api/me")).json()) as {
      entitlements: { credits: Record<string, number> };
    };
    expect(me.entitlements.credits).toEqual({ scout: 0, sweep: 1, probe: 0, siege: 0 });

    const hash = hashOf(OWNER);
    expect(await storedJson(keys.runSummary(hash, runId))).toMatchObject({
      runId,
      status: "queued",
      tier: "sweep",
      scanId,
      target: "staging.example.com",
      trigger: "manual",
      entitlement: "credit",
      coverage: 0,
      agents: { total: 7, done: 0 },
    });
    expect(await storedJson(keys.runInput(hash, runId))).toMatchObject({
      runId,
      scanId,
      trigger: "manual",
      tier: "sweep",
      scan: {
        name: "Weekly sweep",
        frequency: "weekly",
        notify: { email: "team@example.com", on: "always", confirmed: false },
      },
      target: {
        appUrl: "https://staging.example.com",
        hosts: ["staging.example.com", "www.example.com"],
        scopeNotes: "Do not touch /billing",
        logins: { user1: { username: "swarm-test-user1", password: PASSWORD } },
      },
      acknowledgement: { ip: "203.0.113.7" },
      targetVerification: null,
    });
    expect(await storedJson(keys.runCredit(hash, runId))).toMatchObject({
      tier: "sweep",
      entitlement: "credit",
    });
  });

  it("a Siege scan needs a Siege credit, not a Scout one", async () => {
    const { h, owner } = ctx;
    await grant(h, OWNER, "scout", 5);
    await grant(h, OWNER, "sweep", 5);
    const id = await newTarget(owner);
    const scanId = await newScan(owner, id, { tier: "siege", loginSlots: ["user1"] });
    expect((await owner.withCsrf("POST", `/api/scans/${scanId}/run`)).status).toBe(402);
    await grant(h, OWNER, "siege", 1);
    expect((await owner.withCsrf("POST", `/api/scans/${scanId}/run`)).status).toBe(201);
    expect((await owner.withCsrf("POST", `/api/scans/${scanId}/run`)).status).toBe(402);
  });

  it("with one credit, fifty concurrent starts create exactly one run and leave the ledger at zero", async () => {
    const { h, owner } = ctx;
    await grant(h, OWNER, "sweep", 1);
    const scanId = await newScan(owner, await newTarget(owner));
    const results = await Promise.all(
      Array.from({ length: 50 }, () => owner.withCsrf("POST", `/api/scans/${scanId}/run`)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 402)).toHaveLength(49);
    const runs = (await (await owner.request("GET", "/api/runs")).json()) as unknown[];
    expect(runs).toHaveLength(1);
    const me = (await (await owner.request("GET", "/api/me")).json()) as {
      entitlements: { credits: Record<string, number> };
    };
    expect(me.entitlements.credits.sweep).toBe(0);
    const ledger = await storedJson(keys.entitlements(hashOf(OWNER)));
    expect(ledger.consumed.sweep).toBe(1);
  });

  it("runs the same scan twice with the same snapshot, two credits, and no re-entry of logins", async () => {
    const { h, owner } = ctx;
    await grant(h, OWNER, "sweep", 2);
    const id = await newTarget(owner);
    const scanId = await newScan(owner, id);
    const first = await ids.run(await owner.withCsrf("POST", `/api/scans/${scanId}/run`));
    const second = await ids.run(await owner.withCsrf("POST", `/api/scans/${scanId}/run`));
    expect(second).not.toBe(first);
    const hash = hashOf(OWNER);
    const [a, b] = await Promise.all(
      [first, second].map((r) => storedJson(keys.runInput(hash, r))),
    );
    expect({ ...a, runId: 0, createdAt: 0 }).toEqual({ ...b, runId: 0, createdAt: 0 });
    expect((await storedJson(keys.entitlements(hash))).consumed.sweep).toBe(2);

    // Edit the password once: the next run uses it.
    await owner.withCsrf(
      "PUT",
      `/api/targets/${id}`,
      targetBody({
        logins: {
          user1: { username: "swarm-test-user1", password: "rotated-password", description: "d" },
        },
      }),
    );
    await grant(h, OWNER, "sweep", 1);
    const third = await ids.run(await owner.withCsrf("POST", `/api/scans/${scanId}/run`));
    expect((await storedJson(keys.runInput(hash, third))).target.logins.user1.password).toBe(
      "rotated-password",
    );
  });

  it("staff start runs without a credit, flagged as staff, and the ledger is untouched", async () => {
    const { h } = ctx;
    const staff = await signedIn(h, "swarm-test-staff@fhlostonswarm.com");
    const scanId = await newScan(staff, await newTarget(staff));
    const runId = await ids.run(await staff.withCsrf("POST", `/api/scans/${scanId}/run`));
    const hash = hashOf("swarm-test-staff@fhlostonswarm.com");
    expect(await storedJson(keys.runSummary(hash, runId))).toMatchObject({
      entitlement: "staff",
      status: "queued",
    });
    expect(await h.store.get(keys.entitlements(hash))).toBeNull();
  });

  it("returns the credit if the run cannot be written", async () => {
    const { h, owner } = ctx;
    await grant(h, OWNER, "sweep", 1);
    const scanId = await newScan(owner, await newTarget(owner));
    const put = h.store.put.bind(h.store);
    vi.spyOn(h.store, "put").mockImplementation(async (key, body, condition) => {
      if (key.endsWith("/summary.json")) throw new Error("disk full");
      return put(key, body, condition);
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await owner.withCsrf("POST", `/api/scans/${scanId}/run`)).status).toBe(500);
    vi.restoreAllMocks();
    expect(await h.store.list(keys.runsPrefix(hashOf(OWNER)))).toEqual([]);
    const me = (await (await owner.request("GET", "/api/me")).json()) as {
      entitlements: { credits: Record<string, number> };
    };
    expect(me.entitlements.credits.sweep).toBe(1);
  });

  it("lists runs newest first and deletes one run without touching the others", async () => {
    const { h, owner } = ctx;
    await grant(h, OWNER, "sweep", 2);
    const scanId = await newScan(owner, await newTarget(owner));
    const first = await ids.run(await owner.withCsrf("POST", `/api/scans/${scanId}/run`));
    h.clock.advance(60_000);
    const second = await ids.run(await owner.withCsrf("POST", `/api/scans/${scanId}/run`));
    const listed = (await (await owner.request("GET", "/api/runs")).json()) as {
      summary: { runId: string };
      scanId: string;
    }[];
    expect(listed.map((r) => r.summary.runId)).toEqual([second, first]);
    expect(listed[0]!.scanId).toBe(scanId);
    expect(await (await owner.request("GET", `/api/runs/${first}`)).json()).toMatchObject({
      target: "staging.example.com",
    });

    expect((await owner.withCsrf("DELETE", `/api/runs/${first}`)).status).toBe(200);
    expect(await h.store.list(keys.runPrefix(hashOf(OWNER), first))).toEqual([]);
    expect(await h.store.list(keys.runPrefix(hashOf(OWNER), second))).not.toEqual([]);
    expect((await owner.request("GET", `/api/runs/${first}`)).status).toBe(404);
  });

  it("never returns a saved password from any endpoint", async () => {
    const { h, owner } = ctx;
    await grant(h, OWNER, "sweep", 1);
    const id = await newTarget(owner);
    const scanId = await newScan(owner, id);
    const runId = await ids.run(await owner.withCsrf("POST", `/api/scans/${scanId}/run`));
    for (const path of [
      "/api/targets",
      `/api/scans`,
      `/api/scans/${scanId}`,
      "/api/runs",
      `/api/runs/${runId}`,
      "/api/me",
    ]) {
      expect(await (await owner.request("GET", path)).text(), path).not.toContain(PASSWORD);
    }
  });

  it("users cannot see or touch each other's targets, scans or runs (404)", async () => {
    const { h, owner } = ctx;
    await grant(h, OWNER, "sweep", 1);
    const id = await newTarget(owner);
    const scanId = await newScan(owner, id);
    const runId = await ids.run(await owner.withCsrf("POST", `/api/scans/${scanId}/run`));

    const other = await signedIn(h, OTHER);
    await grant(h, OTHER, "sweep", 1);
    expect(await (await other.request("GET", "/api/targets")).json()).toEqual([]);
    expect(await (await other.request("GET", "/api/scans")).json()).toEqual([]);
    expect(await (await other.request("GET", "/api/runs")).json()).toEqual([]);
    for (const [method, path] of [
      ["GET", `/api/scans/${scanId}`],
      ["POST", `/api/scans/${scanId}/run`],
      ["PUT", `/api/targets/${id}`],
      ["DELETE", `/api/targets/${id}`],
      ["DELETE", `/api/scans/${scanId}`],
      ["PATCH", `/api/scans/${scanId}/status`],
      ["GET", `/api/runs/${runId}`],
      ["DELETE", `/api/runs/${runId}`],
    ] as const) {
      const res =
        method === "GET"
          ? await other.request(method, path)
          : await other.withCsrf(
              method,
              path,
              method === "PUT" ? targetBody() : method === "PATCH" ? { status: "paused" } : {},
            );
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    // Nothing of the owner's was spent or removed.
    expect((await storedJson(keys.entitlements(hashOf(OWNER)))).consumed.sweep).toBe(1);
    expect(await h.store.get(keys.runSummary(hashOf(OWNER), runId))).not.toBeNull();
    expect(await h.store.get(keys.target(hashOf(OWNER), id))).not.toBeNull();
    // A scan cannot be pointed at someone else's target.
    const stolen = await other.withCsrf("POST", "/api/scans", scanBody(id));
    expect(stolen.status).toBe(404);
  });

  it("treats malformed ids as not found", async () => {
    const { owner } = ctx;
    for (const path of ["/api/runs/..%2Fprofile", "/api/scans/x", "/api/targets/%2e%2e"]) {
      expect((await owner.request("GET", path)).status, path).toBe(
        path.startsWith("/api/targets") ? 404 : 404,
      );
    }
  });
});

describe("notification address", () => {
  it("the account email is confirmed by sign-in and gets no confirmation mail", async () => {
    const { h, owner } = ctx;
    await newScan(owner, await newTarget(owner), {
      notifyEmail: "SWARM-TEST-OWNER+reports@example.com",
    });
    expect(h.mailer.confirmations).toEqual([]);
    const [scan] = (await (await owner.request("GET", "/api/scans")).json()) as {
      notifyEmailConfirmed: boolean;
    }[];
    expect(scan!.notifyEmailConfirmed).toBe(true);
  });

  const linkToken = (h: Harness, to: string) =>
    new URL(h.mailer.lastConfirmationTo(to)!.link).searchParams.get("token")!;
  const confirm = (h: Harness, token: string) =>
    h.browser("198.51.100.20").request("POST", "/api/notify/confirm", { token });

  it("another address stays unconfirmed until its link is followed once", async () => {
    const { h, owner } = ctx;
    const id = await newTarget(owner);
    const scanId = await newScan(owner, id, { notifyEmail: "team@example.org" });
    expect(h.mailer.confirmations).toHaveLength(1);
    expect(h.mailer.confirmations[0]).toMatchObject({ to: "team@example.org", expiresHours: 48 });
    expect(h.mailer.sent.every((m) => m.to !== "team@example.org")).toBe(true);
    const view = async () =>
      (await (await owner.request("GET", `/api/scans/${scanId}`)).json()) as {
        notifyEmailConfirmed: boolean;
      };
    expect((await view()).notifyEmailConfirmed).toBe(false);

    const token = linkToken(h, "team@example.org");
    // The token is stored only as a hash.
    expect((await h.store.list("auth/notify-confirm/")).join()).not.toContain(token);

    expect((await confirm(h, token)).status).toBe(200);
    expect((await view()).notifyEmailConfirmed).toBe(true);
    const again = await confirm(h, token);
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: "invalid_or_expired_link" });
    expect(await h.store.list("auth/notify-confirm/")).toEqual([]);
  });

  it("an expired or unknown link fails", async () => {
    const { h, owner } = ctx;
    await newScan(owner, await newTarget(owner), { notifyEmail: "team@example.org" });
    const token = linkToken(h, "team@example.org");
    expect((await confirm(h, "x".repeat(32))).status).toBe(400);
    h.clock.advance(49 * 3_600_000);
    expect((await confirm(h, token)).status).toBe(400);
  });

  it("changing the address resets confirmation and revokes the old link", async () => {
    const { h, owner } = ctx;
    const id = await newTarget(owner);
    const scanId = await newScan(owner, id, { notifyEmail: "team@example.org" });
    const oldToken = linkToken(h, "team@example.org");
    expect((await confirm(h, oldToken)).status).toBe(200);

    await owner.withCsrf(
      "PUT",
      `/api/scans/${scanId}`,
      scanBody(id, { notifyEmail: "other@example.org" }),
    );
    const view = (await (await owner.request("GET", `/api/scans/${scanId}`)).json()) as {
      notifyEmailConfirmed: boolean;
    };
    expect(view.notifyEmailConfirmed).toBe(false);
    expect(h.mailer.lastConfirmationTo("other@example.org")).toBeDefined();

    // Editing something else keeps the confirmation of an unchanged address and sends nothing more.
    const newToken = linkToken(h, "other@example.org");
    expect((await confirm(h, newToken)).status).toBe(200);
    const count = h.mailer.confirmations.length;
    await owner.withCsrf(
      "PUT",
      `/api/scans/${scanId}`,
      scanBody(id, { notifyEmail: "other@example.org", name: "Renamed" }),
    );
    expect(h.mailer.confirmations).toHaveLength(count);
    expect(
      (
        (await (await owner.request("GET", `/api/scans/${scanId}`)).json()) as {
          notifyEmailConfirmed: boolean;
        }
      ).notifyEmailConfirmed,
    ).toBe(true);

    // A link for an address that was since replaced no longer works.
    await owner.withCsrf(
      "PUT",
      `/api/scans/${scanId}`,
      scanBody(id, { notifyEmail: "third@example.org" }),
    );
    const staleToken = linkToken(h, "third@example.org");
    await owner.withCsrf(
      "PUT",
      `/api/scans/${scanId}`,
      scanBody(id, { notifyEmail: "fourth@example.org" }),
    );
    expect((await confirm(h, staleToken)).status).toBe(400);
  });

  it("sends no confirmation when notifications are off, and asks once they are turned on", async () => {
    const { h, owner } = ctx;
    const id = await newTarget(owner);
    const scanId = await newScan(owner, id, { notifyEmail: "team@example.org", notifyOn: "never" });
    expect(h.mailer.confirmations).toEqual([]);
    await owner.withCsrf(
      "PUT",
      `/api/scans/${scanId}`,
      scanBody(id, { notifyEmail: "team@example.org", notifyOn: "new" }),
    );
    expect(h.mailer.confirmations).toHaveLength(1);
  });

  it("limits confirmation mails per scan, and resend honours the limit", async () => {
    const { h, owner } = ctx;
    const id = await newTarget(owner);
    const scanId = await newScan(owner, id, { notifyEmail: "team@example.org" });
    expect((await owner.withCsrf("POST", `/api/scans/${scanId}/notify/resend`)).status).toBe(200);
    expect((await owner.withCsrf("POST", `/api/scans/${scanId}/notify/resend`)).status).toBe(200);
    const limited = await owner.withCsrf("POST", `/api/scans/${scanId}/notify/resend`);
    expect(limited.status).toBe(429);
    expect(h.mailer.confirmations).toHaveLength(3);
    // Being limited does not cost the customer the link they already have.
    expect(await h.store.list("auth/notify-confirm/")).toHaveLength(1);
    expect((await confirm(h, linkToken(h, "team@example.org"))).status).toBe(200);
    expect(await h.store.list("auth/notify-confirm/")).toHaveLength(0);
    h.clock.advance(3_600_000);
    await h.signIn(owner, OWNER);
    // Once confirmed there is nothing left to resend.
    const done = await owner.withCsrf("POST", `/api/scans/${scanId}/notify/resend`);
    expect(await done.json()).toEqual({ ok: true, confirmed: true });
    expect(h.mailer.confirmations).toHaveLength(3);
  });

  it("limits confirmation mails per account across scans", async () => {
    const { h, owner } = ctx;
    const id = await newTarget(owner);
    for (let i = 0; i < 12; i++)
      await newScan(owner, id, {
        name: `Scan ${i}`,
        frequency: "once",
        notifyEmail: `team${i}@example.org`,
      });
    expect(h.mailer.confirmations).toHaveLength(10);
  });

  it("still saves the scan when the mailer fails", async () => {
    const h = createHarness();
    vi.spyOn(h.mailer, "sendNotifyConfirmation").mockRejectedValue(new Error("ses down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const owner = await signedIn(h);
    const scanId = await newScan(owner, await newTarget(owner), {
      notifyEmail: "team@example.org",
    });
    expect(
      (
        (await (await owner.request("GET", `/api/scans/${scanId}`)).json()) as {
          notifyEmailConfirmed: boolean;
        }
      ).notifyEmailConfirmed,
    ).toBe(false);
  });

  it("deleting a scan revokes its pending link", async () => {
    const { h, owner } = ctx;
    const scanId = await newScan(owner, await newTarget(owner), {
      notifyEmail: "team@example.org",
    });
    const token = linkToken(h, "team@example.org");
    await owner.withCsrf("DELETE", `/api/scans/${scanId}`);
    expect((await confirm(h, token)).status).toBe(400);
    expect(await h.store.list("auth/notify-confirm/")).toEqual([]);
  });
});

describe("account deletion", () => {
  const populate = async (h: Harness, b: TestBrowser, email: string) => {
    await grant(h, email, "sweep", 3);
    const id = await newTarget(b);
    const scanId = await newScan(b, id, { notifyEmail: "team@example.org", notifyOn: "always" });
    const second = await newScan(b, id, { name: "Second", notifyEmail: email });
    await b.withCsrf("POST", `/api/scans/${scanId}/run`);
    await b.withCsrf("POST", `/api/scans/${second}/run`);
  };
  const objectsOf = (h: Harness, hash: string) => h.store.list(`users/${hash}/`);

  it("removes everything for the account and nothing for anyone else", async () => {
    const { h, owner } = ctx;
    await populate(h, owner, OWNER);
    const other = await signedIn(h, OTHER);
    await populate(h, other, OTHER);
    await h.store.put(keys.suppression(hashOf(OWNER)), "{}");
    const hash = hashOf(OWNER);
    const otherBefore = await objectsOf(h, hashOf(OTHER));
    expect((await objectsOf(h, hash)).length).toBeGreaterThan(8);

    const request = await owner.withCsrf("POST", "/api/account/delete-code");
    expect(request.status).toBe(200);
    const { code } = h.mailer.lastDeletionCodeTo(OWNER)!;
    const res = await owner.withCsrf("DELETE", "/api/account", { code });
    expect(res.status).toBe(200);

    expect(await objectsOf(h, hash)).toEqual([]);
    expect(await h.store.get(keys.otp(hash))).toBeNull();
    expect(await h.store.list(keys.emailRateLimits(hash))).toEqual([]);
    expect(await h.store.list("auth/notify-confirm/")).toHaveLength(1); // the other user's
    expect(h.mailer.deleted).toEqual([OWNER]);
    // The sign-in session is gone and the cookies are cleared.
    expect((await owner.request("GET", "/api/me")).status).toBe(401);
    expect(owner.names()).toEqual([]);
    // Another account's data is untouched; a bounce suppression is kept.
    expect(await objectsOf(h, hashOf(OTHER))).toEqual(otherBefore);
    expect(await h.store.get(keys.suppression(hash))).not.toBeNull();
    await h.store.delete(keys.suppression(hash));
    // Signing in again starts from scratch.
    const again = await signedIn(h);
    expect(await (await again.request("GET", "/api/scans")).json()).toEqual([]);
  });

  it("needs a fresh code: a wrong one or none deletes nothing", async () => {
    const { h, owner } = ctx;
    await populate(h, owner, OWNER);
    const hash = hashOf(OWNER);
    const before = await objectsOf(h, hash);
    const none = await owner.withCsrf("DELETE", "/api/account", { code: "123456" });
    expect(none.status).toBe(400);
    expect(await none.json()).toEqual({ error: "invalid_or_expired_code" });

    await owner.withCsrf("POST", "/api/account/delete-code");
    const { code } = h.mailer.lastDeletionCodeTo(OWNER)!;
    const wrong = code === "000000" ? "111111" : "000000";
    expect((await owner.withCsrf("DELETE", "/api/account", { code: wrong })).status).toBe(400);
    expect(await objectsOf(h, hash)).toEqual(before);
    expect((await owner.withCsrf("DELETE", "/api/account", { code })).status).toBe(200);
    // A code works once.
    expect((await h.browser().withCsrf("DELETE", "/api/account", { code })).status).toBe(401);
  });

  it("an expired code is refused", async () => {
    const { h, owner } = ctx;
    await owner.withCsrf("POST", "/api/account/delete-code");
    const { code } = h.mailer.lastDeletionCodeTo(OWNER)!;
    h.clock.advance(11 * 60_000);
    const res = await owner.withCsrf("DELETE", "/api/account", { code });
    expect([400, 401]).toContain(res.status);
    expect(await objectsOf(h, hashOf(OWNER))).not.toEqual([]);
  });

  it("needs a session and the CSRF token", async () => {
    const { h, owner } = ctx;
    expect((await h.browser().withCsrf("POST", "/api/account/delete-code")).status).toBe(401);
    expect((await owner.request("DELETE", "/api/account", { code: "123456" })).status).toBe(403);
  });
});

describe("credits for staff and /api/me", () => {
  it("marks staff as unmetered and reports balances for everyone else", async () => {
    const { h, owner } = ctx;
    await grant(h, OWNER, "probe", 3);
    const me = (await (await owner.request("GET", "/api/me")).json()) as {
      entitlements: { credits: Record<string, number>; unmetered: boolean };
    };
    expect(me.entitlements).toEqual({
      credits: { scout: 0, sweep: 0, probe: 3, siege: 0 },
      unmetered: false,
    });
    const staff = await signedIn(h, "swarm-test-staff2@fhlostonswarm.com");
    const staffMe = (await (await staff.request("GET", "/api/me")).json()) as {
      entitlements: { unmetered: boolean };
    };
    expect(staffMe.entitlements.unmetered).toBe(true);
  });
});
