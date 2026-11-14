import { pricing, runCostSchema, limitsFor, bedrockUsd } from "@swarm/shared/server";
import type { CostAnalysis, StaffControls, StaffRunsResponse, TierId } from "@swarm/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCredits, grantCredits } from "./credits.js";
import { finalizeRun } from "./finalize.js";
import { emailHash, parseEmail } from "./identity.js";
import { internalApp } from "./internal.js";
import { acquireRun } from "./pool.js";
import { runToken } from "./runtoken.js";
import { keys } from "./storage/keys.js";
import { createHarness, testSecrets, type Harness, type TestBrowser } from "./testkit.js";

const hashOf = (address: string) => emailHash(testSecrets.pepper, parseEmail(address)!);
const STAFF = "swarm-test-staff@fhlostonswarm.com";
const CUSTOMER = "swarm-test-customer@example.com";
const OTHER = "swarm-test-other@example.com";

interface Seeded {
  runId: string;
  owner: string;
  browser: TestBrowser;
  scanId: string;
  internal: (method: string, path: string, body?: unknown) => Promise<Response>;
}

const SWEEP_MODEL = limitsFor("sweep").modelId;

async function customer(h: Harness, email = CUSTOMER, ip?: string) {
  const browser = h.browser(ip);
  await h.signIn(browser, email);
  return browser;
}

async function newScan(
  h: Harness,
  browser: TestBrowser,
  options: { tier?: TierId; frequency?: string; name?: string; notifyEmail?: string } = {},
): Promise<string> {
  const target = await browser.withCsrf("POST", "/api/targets", {
    appUrl: "https://staging.example.com",
    marketingUrl: "",
    scopeNotes: "",
    logins: { user1: { username: "swarm-test-user1", password: "pw-test-1", description: "User" } },
    acknowledged: true,
  });
  expect(target.status).toBe(201);
  const targetId = ((await target.json()) as { id: string }).id;
  const scan = await browser.withCsrf("POST", "/api/scans", {
    targetId,
    name: options.name ?? "Scan",
    tier: options.tier ?? "sweep",
    frequency: options.frequency ?? "once",
    timezone: "Australia/Sydney",
    notifyEmail: options.notifyEmail ?? CUSTOMER,
    notifyOn: "always",
    loginSlots: ["user1"],
  });
  expect(scan.status, await scan.clone().text()).toBe(201);
  return ((await scan.json()) as { id: string }).id;
}

/** Creates a customer's run and starts it (it holds a slot and is running). */
async function startRun(
  h: Harness,
  options: { email?: string; tier?: TierId; credits?: number; source?: "comp" | "purchase" } = {},
): Promise<Seeded> {
  const email = options.email ?? CUSTOMER;
  const tier = options.tier ?? "sweep";
  const browser = await customer(h, email, "203.0.113.50");
  const owner = hashOf(email);
  await grantCredits(
    h.store,
    owner,
    {
      tier,
      count: options.credits ?? 2,
      source: options.source ?? "comp",
      reason: "test",
      by: "tester",
    },
    h.clock.now(),
    true,
  );
  const scanId = await newScan(h, browser, { tier, notifyEmail: email });
  const run = await browser.withCsrf("POST", `/api/scans/${scanId}/run`);
  expect(run.status, await run.clone().text()).toBe(201);
  const { runId } = (await run.json()) as { runId: string };
  expect((await browser.withCsrf("POST", `/api/runs/${runId}/start`)).status).toBe(200);
  const app = internalApp({
    store: h.store,
    secrets: async () => testSecrets,
    publisher: h.publisher,
    now: h.clock.now,
    requireIam: false,
  });
  const internal = (method: string, path: string, body?: unknown) =>
    Promise.resolve(
      app.request(`/api/internal${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-swarm-owner": owner,
          "x-swarm-run": runId,
          "x-swarm-token": runToken(testSecrets, owner, runId),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  return { runId, owner, browser, scanId, internal };
}

const events = (runId: string, ts: string) => [
  { runId, ts, type: "dispatch", agent: "tls", payload: { task: "Check transport" } },
  {
    runId,
    ts,
    type: "start",
    agent: "tls",
    payload: { stepId: "protocols", label: "Negotiate protocol versions" },
  },
  {
    runId,
    ts,
    type: "finish",
    agent: "tls",
    payload: {
      outcome: "clear",
      stepId: "protocols",
      label: "Negotiate protocol versions",
      requests: 2,
    },
  },
];

const deps = (h: Harness) => ({
  store: h.store,
  mailer: h.mailer,
  publisher: h.publisher,
  now: h.clock.now,
  siteOrigin: "https://fhlostonswarm.com",
  alertTo: "support@fhlostonswarm.com",
});

/** Reports the task's usage and closes the run, so it has a cost record and an index entry. */
async function close(
  h: Harness,
  run: Seeded,
  usage: { inputTokens: number; outputTokens: number; calls?: number },
  options: { taskSeconds?: number; bytesOut?: number } = {},
) {
  await run.internal("POST", "/events", {
    batchId: `batch-${run.runId.slice(-8)}`,
    events: events(run.runId, new Date(h.clock.now()).toISOString()),
  });
  await run.internal("POST", "/evidence", {
    name: "usage",
    body: { modelId: SWEEP_MODEL, calls: usage.calls ?? 10, ...usage, usd: 0 },
  });
  await run.internal("POST", "/evidence", {
    name: "proxy-stats",
    body: {
      uptimeSeconds: (options.taskSeconds ?? 600) - 20,
      requests: 3,
      blocked: 0,
      bytesOut: options.bytesOut ?? 1024 ** 3,
      bytesIn: 0,
    },
  });
  h.clock.advance(60_000);
  return finalizeRun(deps(h), { emailHash: run.owner, runId: run.runId }, { kind: "finished" });
}

let h: Harness;
let staff: TestBrowser;
beforeEach(async () => {
  h = createHarness();
  staff = h.browser("198.51.100.20");
  expect((await h.signIn(staff, STAFF)).status).toBe(200);
});

const get = async <T>(path: string): Promise<T> => {
  const res = await staff.request("GET", path);
  expect(res.status, `${path}: ${await res.clone().text()}`).toBe(200);
  return (await res.json()) as T;
};

describe("who can use /api/staff", () => {
  it("answers 403 to a customer and 401 to nobody on every staff route", async () => {
    const buyer = await customer(h, CUSTOMER, "203.0.113.9");
    const stranger = h.browser("203.0.113.10");
    const routes = h.app.routes.filter(
      (r) => r.path.startsWith("/api/staff/") && r.method !== "ALL",
    );
    // The staff API is real: more than a handful of routes, and none missed by the check below.
    expect(routes.length).toBeGreaterThan(20);
    const concrete = (path: string) =>
      path
        .replace(":id", "run_0000000aaaaaaaaaaaaaa")
        .replace(":hash", "a".repeat(64))
        .replace(":scanId", "scan_0000000aaaaaaaaaaaaaa");
    for (const route of routes) {
      const path = concrete(route.path);
      const body = route.method === "GET" ? undefined : {};
      const customerRes = await buyer.withCsrf(route.method, path, body);
      expect(customerRes.status, `${route.method} ${path} as a customer`).toBe(403);
      const anonymousRes = await stranger.request(route.method, path, body);
      expect(anonymousRes.status, `${route.method} ${path} with no session`).toBe(401);
    }
    // A path that does not exist is closed too, not a 404 that tells a customer what is there.
    expect((await buyer.request("GET", "/api/staff/anything/at/all")).status).toBe(403);
  });

  it("lets staff in, and a customer's request must also carry the CSRF token", async () => {
    expect((await staff.request("GET", "/api/staff/whoami")).status).toBe(200);
    const noCsrf = await staff.request("PUT", "/api/staff/controls", {});
    expect(noCsrf.status).toBe(403);
    expect(await noCsrf.json()).toEqual({ error: "bad_csrf" });
  });
});

describe("runs and costs", () => {
  it("costs a run from its tokens and the price table, and the analysis matches a hand calculation", async () => {
    const a = await startRun(h, { email: CUSTOMER });
    const b = await startRun(h, { email: OTHER, source: "purchase" });
    await close(h, a, { inputTokens: 1_000_000, outputTokens: 100_000 });
    await close(h, b, { inputTokens: 500_000, outputTokens: 50_000 });

    // By hand: tokens x the Haiku price, a 600 s task on 1 vCPU and 2 GB, 1 GiB out, 8 transitions.
    const bedrock = (i: number, o: number) => (i * 1 + o * 5) / 1e6;
    const fargate = (600 / 3600) * (1 * 0.0506 + 2 * 0.0056);
    const egress = 1 * 0.114;
    const orchestration = 8 * 0.000025;
    const total = (i: number, o: number) => bedrock(i, o) + fargate + egress + orchestration;
    expect(bedrockUsd(SWEEP_MODEL, { inputTokens: 1_000_000, outputTokens: 100_000 })).toBeCloseTo(
      bedrock(1_000_000, 100_000),
      9,
    );

    const cost = runCostSchema.parse(
      JSON.parse((await h.store.get(keys.runCost(a.owner, a.runId)))!.body),
    );
    expect(cost.bedrock).toMatchObject({ modelId: SWEEP_MODEL, calls: 10, usd: 1.5 });
    expect(cost.totalUsd).toBeCloseTo(total(1_000_000, 100_000), 5);

    const runs = await get<StaffRunsResponse>("/api/staff/runs?test=only");
    expect(runs.rows).toHaveLength(2);
    expect(runs.rows.find((r) => r.runId === a.runId)).toMatchObject({
      tier: "sweep",
      entitlement: "comp",
      status: "complete",
      live: false,
    });
    expect(runs.rows.find((r) => r.runId === b.runId)?.entitlement).toBe("purchase");

    const analysis = await get<CostAnalysis>("/api/staff/costs?test=only");
    const [x, y] = [total(1_000_000, 100_000), total(500_000, 50_000)];
    expect(analysis.runs).toBe(2);
    expect(analysis.totalUsd).toBeCloseTo(x + y, 4);
    expect(analysis.byTier.sweep).toMatchObject({ runs: 2 });
    expect(analysis.byTier.sweep.avgUsd).toBeCloseTo((x + y) / 2, 4);
    expect(analysis.byTier.sweep.medianUsd).toBeCloseTo((x + y) / 2, 4);
    expect(analysis.byTier.sweep.p95Usd).toBeCloseTo(Math.max(x, y), 4);
    expect(analysis.byTier.scout.runs).toBe(0);
    expect(analysis.bySource.comp.usd).toBeCloseTo(x, 4);
    expect(analysis.bySource.purchase.usd).toBeCloseTo(y, 4);
    expect(analysis.components.bedrockUsd).toBeCloseTo(
      bedrock(1_000_000, 100_000) + bedrock(500_000, 50_000),
      6,
    );
    expect(analysis.byDay).toHaveLength(1);
    expect(analysis.topRuns[0]?.runId).toBe(a.runId);
    // Test accounts are left out unless asked for.
    expect((await get<CostAnalysis>("/api/staff/costs")).runs).toBe(0);
  });

  it("lists runs that are still going, and filters by depth, trigger and who paid", async () => {
    const running = await startRun(h, { email: CUSTOMER });
    const done = await startRun(h, { email: OTHER, tier: "sweep" });
    await close(h, done, { inputTokens: 1000, outputTokens: 100 });
    const all = await get<StaffRunsResponse>("/api/staff/runs?test=only");
    expect(all.rows.find((r) => r.runId === running.runId)).toMatchObject({
      live: true,
      costUsd: null,
      status: "running",
    });
    expect(
      (await get<StaffRunsResponse>("/api/staff/runs?test=only&status=complete")).rows,
    ).toHaveLength(1);
    expect((await get<StaffRunsResponse>("/api/staff/runs?test=only&tier=siege")).rows).toEqual([]);
    expect(
      (await get<StaffRunsResponse>("/api/staff/runs?test=only&entitlement=staff")).rows,
    ).toEqual([]);
    expect(
      (await get<StaffRunsResponse>("/api/staff/runs?test=only&trigger=manual")).rows,
    ).toHaveLength(2);
  });

  it("shows a run's cost by component, its caps against what it used, and its agents", async () => {
    const run = await startRun(h);
    await close(h, run, { inputTokens: 200_000, outputTokens: 10_000, calls: 7 });
    const detail = (
      await get<{ detail: import("@swarm/shared").StaffRunDetail; row: unknown }>(
        `/api/staff/runs/${run.runId}`,
      )
    ).detail;
    expect(detail).toMatchObject({
      tier: "sweep",
      entitlement: "comp",
      test: true,
      status: "complete",
    });
    expect(detail.cost?.bedrock).toMatchObject({
      calls: 7,
      inputTokens: 200_000,
      modelId: SWEEP_MODEL,
    });
    const caps = limitsFor("sweep");
    expect(detail.budgets).toContainEqual({
      name: "Input tokens",
      used: 200_000,
      cap: caps.tokenCap!.input,
      unit: "tokens",
    });
    expect(detail.agents.find((a) => a.agent === "tls")).toMatchObject({ steps: 1, requests: 2 });
    expect(detail.events.at(-1)?.type).toBe("complete");
    expect(detail.reportReady).toBe(true);
    expect((await staff.request("GET", "/api/staff/runs/run_0000000aaaaaaaaaaaaaa")).status).toBe(
      404,
    );
  });

  it("keeps only the anonymised cost record when an account is deleted", async () => {
    const run = await startRun(h);
    await close(h, run, { inputTokens: 1000, outputTokens: 100 });
    await run.browser.withCsrf("POST", "/api/account/delete-code");
    const code = h.mailer.lastDeletionCodeTo(CUSTOMER)!.code;
    expect((await run.browser.withCsrf("DELETE", "/api/account", { code })).status).toBe(200);
    expect(await h.store.list(keys.userPrefix(run.owner))).toEqual([]);

    const body = await get<{ detail: unknown; row: { runId: string; costUsd: number } }>(
      `/api/staff/runs/${run.runId}`,
    );
    expect(body.detail).toBeNull();
    expect(body.row).toMatchObject({ runId: run.runId });
    expect(body.row.costUsd).toBeGreaterThan(0);
    expect((await get<CostAnalysis>("/api/staff/costs?test=only")).runs).toBe(1);
    const [key] = (await h.store.list("admin/run-index/")).filter((k) =>
      k.endsWith(`${run.runId}.json`),
    );
    const raw = (await h.store.get(key!))!.body;
    expect(raw).not.toContain(run.owner);
    expect(raw).not.toContain(CUSTOMER);
    expect(raw).not.toContain("staging.example.com");
  });
});

describe("support tools", () => {
  it("looks an account up by email: credits, saved scans and runs, never passwords", async () => {
    const run = await startRun(h);
    const found = await get<import("@swarm/shared").StaffAccount>(
      `/api/staff/accounts?email=${encodeURIComponent(CUSTOMER)}`,
    );
    expect(found).toMatchObject({
      accountHash: run.owner,
      email: CUSTOMER,
      role: "customer",
      test: true,
      targets: 1,
    });
    expect(found.scans).toHaveLength(1);
    expect(found.runs.map((r) => r.runId)).toEqual([run.runId]);
    expect(found.credits.sweep).toBe(1);
    expect(JSON.stringify(found)).not.toContain("pw-test-1");
    expect(
      (await staff.request("GET", `/api/staff/accounts?email=nobody%40example.com`)).status,
    ).toBe(404);
    expect((await staff.request("GET", `/api/staff/accounts?email=not-an-email`)).status).toBe(400);
  });

  it("grants exactly one comp credit with a reason, and audit-logs it without the email", async () => {
    const owner = hashOf(CUSTOMER);
    await customer(h, CUSTOMER, "203.0.113.60");
    const before = (await getCredits(h.store, owner)).scout;
    const res = await staff.withCsrf("POST", `/api/staff/accounts/${owner}/credits`, {
      tier: "scout",
      count: 1,
      reason: "beta tester",
    });
    expect(res.status).toBe(200);
    expect((await getCredits(h.store, owner)).scout).toBe(before + 1);
    expect(
      (
        await staff.withCsrf("POST", `/api/staff/accounts/${owner}/credits`, {
          tier: "scout",
          count: 1,
          reason: "",
        })
      ).status,
    ).toBe(400);
    expect((await getCredits(h.store, owner)).scout).toBe(before + 1);

    const audit =
      await get<{ action: string; by: string; detail: Record<string, unknown> }[]>(
        "/api/staff/audit",
      );
    const grant = audit.filter((a) => a.action === "grant-credit");
    expect(grant).toHaveLength(1);
    expect(grant[0]).toMatchObject({
      by: STAFF,
      detail: { emailHash: owner, tier: "scout", count: 1, reason: "beta tester", source: "comp" },
    });
    expect(JSON.stringify(audit)).not.toContain(CUSTOMER);
  });

  it("pauses a scan, stops a running run, resends the report email and deletes a run, all audit-logged", async () => {
    const run = await startRun(h);
    const pause = await staff.withCsrf(
      "PATCH",
      `/api/staff/accounts/${run.owner}/scans/${run.scanId}/status`,
      { status: "paused" },
    );
    expect(pause.status).toBe(200);
    const scans = (await (await run.browser.request("GET", "/api/scans")).json()) as {
      status: string;
    }[];
    expect(scans[0]?.status).toBe("paused");

    expect((await staff.withCsrf("POST", `/api/staff/runs/${run.runId}/resend-email`)).status).toBe(
      409,
    );
    const stop = await staff.withCsrf("POST", `/api/staff/runs/${run.runId}/stop`);
    expect(await stop.json()).toMatchObject({ ok: true, status: "stopped" });
    expect(h.launcher.stopped).toContainEqual({ owner: run.owner, runId: run.runId });
    expect((await staff.withCsrf("POST", `/api/staff/runs/${run.runId}/stop`)).status).toBe(409);

    // The scan's notification address is the account's own, so it counts as confirmed.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const send = vi.spyOn(h.mailer, "sendReportReady").mockRejectedValueOnce(new Error("ses down"));
    const resend = () => staff.withCsrf("POST", `/api/staff/runs/${run.runId}/resend-email`);
    expect((await resend()).status).toBe(503);
    send.mockRestore();
    expect((await resend()).status).toBe(200);
    expect(h.mailer.reports.at(-1)).toMatchObject({ to: CUSTOMER, status: "stopped" });

    expect((await staff.withCsrf("DELETE", `/api/staff/runs/${run.runId}`)).status).toBe(200);
    expect(await h.store.list(keys.runPrefix(run.owner, run.runId))).toEqual([]);

    const actions = (await get<{ action: string }[]>("/api/staff/audit")).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(["set-scan-status", "stop-run", "resend-report-email", "delete-run"]),
    );
  });

  it("deletes an account on request, stops its runs, and logs it with the account hash", async () => {
    const run = await startRun(h);
    const res = await staff.withCsrf("DELETE", `/api/staff/accounts/${run.owner}`, {
      reason: "asked by email",
    });
    expect(res.status).toBe(200);
    expect(await h.store.list(keys.userPrefix(run.owner))).toEqual([]);
    expect(h.launcher.stopped).toHaveLength(1);
    expect(h.mailer.deleted).toContain(CUSTOMER);
    const audit =
      await get<{ action: string; detail: Record<string, unknown> }[]>("/api/staff/audit");
    expect(audit.find((a) => a.action === "delete-account")?.detail).toMatchObject({
      accountHash: run.owner,
      reason: "asked by email",
    });
    expect(
      (await staff.withCsrf("DELETE", `/api/staff/accounts/${run.owner}`, { reason: "again" }))
        .status,
    ).toBe(404);
  });
});

describe("controls", () => {
  const controls = () => get<StaffControls>("/api/staff/controls");
  const put = (body: unknown) => staff.withCsrf("PUT", "/api/staff/controls", body);

  it("the kill switch stops new runs, halts running and waiting ones, and can be turned off", async () => {
    const running = await startRun(h, { email: CUSTOMER });
    const waiting = await customer(h, OTHER, "203.0.113.70");
    await grantCredits(
      h.store,
      hashOf(OTHER),
      { tier: "sweep", count: 1, source: "comp", reason: "t", by: "t" },
      h.clock.now(),
      true,
    );
    const waitScan = await newScan(h, waiting, { notifyEmail: OTHER });
    const queued = (await (
      await waiting.withCsrf("POST", `/api/scans/${waitScan}/run`)
    ).json()) as {
      runId: string;
    };

    const res = await staff.withCsrf("POST", "/api/staff/controls/kill-switch", {
      on: true,
      reason: "drill",
    });
    expect(await res.json()).toMatchObject({
      stopped: 2,
      controls: { killSwitch: { on: true, by: STAFF } },
    });
    const status = async (owner: string, runId: string) =>
      JSON.parse((await h.store.get(keys.runSummary(owner, runId)))!.body).status;
    expect(await status(running.owner, running.runId)).toBe("stopped");
    expect(await status(hashOf(OTHER), queued.runId)).toBe("stopped");
    // The run that had not started gets its credit back.
    expect((await getCredits(h.store, hashOf(OTHER))).sweep).toBe(1);

    // No new run can be created or started while it is on.
    const blocked = await waiting.withCsrf("POST", `/api/scans/${waitScan}/run`);
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toEqual({ error: "service_paused" });

    await staff.withCsrf("POST", "/api/staff/controls/kill-switch", {
      on: false,
      reason: "drill over",
    });
    expect((await waiting.withCsrf("POST", `/api/scans/${waitScan}/run`)).status).toBe(201);
    const actions = (await get<{ action: string }[]>("/api/staff/audit")).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["kill-switch-on", "kill-switch-off"]));
  });

  it("a run caught by the kill switch before its execution takes a slot is not started", async () => {
    const buyer = await customer(h, CUSTOMER, "203.0.113.80");
    await grantCredits(
      h.store,
      hashOf(CUSTOMER),
      { tier: "sweep", count: 1, source: "comp", reason: "t", by: "t" },
      h.clock.now(),
      true,
    );
    const scan = await newScan(h, buyer);
    const { runId } = (await (await buyer.withCsrf("POST", `/api/scans/${scan}/run`)).json()) as {
      runId: string;
    };
    await staff.withCsrf("POST", "/api/staff/controls/kill-switch", { on: true, reason: "drill" });
    await expect(
      acquireRun(h.store, { emailHash: hashOf(CUSTOMER), runId }, h.clock.now()),
    ).rejects.toThrow("kill_switch");
  });

  it("a per-depth concurrency change takes effect at once, without a deploy", async () => {
    expect(limitsFor("sweep").concurrency).toBeGreaterThan(1);
    expect((await put({ concurrency: { sweep: 1 } })).status).toBe(200);
    expect((await controls()).concurrency.sweep).toBe(1);
    const first = await startRun(h, { email: CUSTOMER });
    // A second run of the depth now waits for the slot.
    const other = await customer(h, OTHER, "203.0.113.71");
    await grantCredits(
      h.store,
      hashOf(OTHER),
      { tier: "sweep", count: 1, source: "comp", reason: "t", by: "t" },
      h.clock.now(),
      true,
    );
    const scan = await newScan(h, other, { notifyEmail: OTHER });
    const { runId } = (await (await other.withCsrf("POST", `/api/scans/${scan}/run`)).json()) as {
      runId: string;
    };
    await other.withCsrf("POST", `/api/runs/${runId}/start`);
    const summary = JSON.parse((await h.store.get(keys.runSummary(hashOf(OTHER), runId)))!.body);
    expect(summary.status).toBe("queued");
    expect(summary.reason).toMatch(/Waiting for a free/);
    expect(first.runId).toBeDefined();
    // Putting it back lets the waiting run in on its next poll.
    expect((await put({ concurrency: {} })).status).toBe(200);
    expect((await controls()).concurrency.sweep).toBe(limitsFor("sweep").concurrency);
    await acquireRun(h.store, { emailHash: hashOf(OTHER), runId }, h.clock.now());
    expect(
      JSON.parse((await h.store.get(keys.runSummary(hashOf(OTHER), runId)))!.body).status,
    ).toBe("running");
  });

  it("the scheduled-scan limits apply to the next scan saved, without a deploy", async () => {
    const buyer = await customer(h, CUSTOMER, "203.0.113.72");
    const target = await buyer.withCsrf("POST", "/api/targets", {
      appUrl: "https://staging.example.com",
      marketingUrl: "",
      scopeNotes: "",
      logins: {},
      acknowledged: true,
    });
    const targetId = ((await target.json()) as { id: string }).id;
    const save = (name: string, frequency: string) =>
      buyer.withCsrf("POST", "/api/scans", {
        targetId,
        name,
        tier: "scout",
        frequency,
        timezone: "Australia/Sydney",
        notifyEmail: CUSTOMER,
        notifyOn: "never",
        loginSlots: [],
      });
    expect((await save("one", "daily")).status).toBe(201);
    expect(
      (await put({ scheduledScans: { maxActivePerAccount: 1, minSpacingHours: 24 } })).status,
    ).toBe(200);
    const second = await save("two", "weekly");
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "scheduled_limit" });
    // One-off scans are not scheduled runs.
    expect((await save("once", "once")).status).toBe(201);
    expect(
      (await put({ scheduledScans: { maxActivePerAccount: 3, minSpacingHours: 48 } })).status,
    ).toBe(200);
    const tooOften = await save("often", "daily");
    expect(await tooOften.json()).toEqual({ error: "schedule_too_frequent" });
    expect(
      (await put({ scheduledScans: { maxActivePerAccount: 3, minSpacingHours: 24 } })).status,
    ).toBe(200);
    expect((await save("two", "weekly")).status).toBe(201);
  });

  it("a depth's caps reach the next run's budgets, and invalid caps are refused", async () => {
    const run = await startRun(h);
    const budget = async () => {
      const res = await run.internal("GET", "/input");
      return (
        (await res.json()) as { budgets: { maxRequests: number; llm: { spendCapUsd: number } } }
      ).budgets;
    };
    const original = limitsFor("sweep");
    expect((await budget()).maxRequests).toBe(original.requestCap);
    expect((await put({ caps: { sweep: { requestCap: 123, spendCapUsd: 2.5 } } })).status).toBe(
      200,
    );
    expect(await budget()).toMatchObject({ maxRequests: 123, llm: { spendCapUsd: 2.5 } });
    expect((await controls()).caps.sweep.requestCap).toBe(123);
    // Spend caps must still rise with depth, so a Sweep cap above Probe's is refused and changes nothing.
    const bad = await put({ caps: { sweep: { spendCapUsd: limitsFor("probe").spendCapUsd + 1 } } });
    expect(bad.status).toBe(400);
    expect((await controls()).caps.sweep.spendCapUsd).toBe(2.5);
    expect((await put({ caps: { sweep: { requestCap: 0 } } })).status).toBe(400);
    expect((await put({ caps: { sweep: { modelId: "other" } } })).status).toBe(400);
    expect((await put({ caps: {} })).status).toBe(200);
    expect((await budget()).maxRequests).toBe(original.requestCap);
  });

  it("blocks hosts and email domains staff add", async () => {
    expect(
      (await put({ blockedHosts: ["blocked-corp.example"], blockedEmailDomains: ["spam.example"] }))
        .status,
    ).toBe(200);
    const buyer = await customer(h, CUSTOMER, "203.0.113.73");
    const target = (appUrl: string) =>
      buyer.withCsrf("POST", "/api/targets", {
        appUrl,
        marketingUrl: "",
        scopeNotes: "",
        logins: {},
        acknowledged: true,
      });
    const refused = await target("https://app.blocked-corp.example/");
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "app_url_blocked_host" });
    expect((await target("https://staging.example.com/")).status).toBe(201);

    const before = h.mailer.sent.length;
    const anon = h.browser("203.0.113.74");
    expect(
      (await anon.request("POST", "/api/auth/request", { email: "x@mail.spam.example" })).status,
    ).toBe(200);
    expect(h.mailer.sent.length).toBe(before);
    expect(
      (await anon.request("POST", "/api/auth/request", { email: "x@fine.example" })).status,
    ).toBe(200);
    expect(h.mailer.sent.length).toBe(before + 1);
  });

  it("logs every change with what it was and what it became", async () => {
    await put({ dailySpendAlarmUsd: 50, blockedEmailDomains: ["a.example"] });
    h.clock.advance(1000);
    await put({ dailySpendAlarmUsd: null });
    const audit = await get<
      {
        action: string;
        by: string;
        detail: {
          changed: string[];
          before: Record<string, unknown>;
          after: Record<string, unknown>;
        };
      }[]
    >("/api/staff/audit");
    const sets = audit.filter((a) => a.action === "set-controls");
    expect(sets).toHaveLength(2);
    expect(sets[1]?.detail).toMatchObject({
      changed: ["dailySpendAlarmUsd", "blockedEmailDomains"],
      after: { dailySpendAlarmUsd: 50 },
    });
    expect(sets[0]?.detail).toMatchObject({
      before: { dailySpendAlarmUsd: 50 },
      after: { dailySpendAlarmUsd: null },
    });
    expect(sets[0]?.by).toBe(STAFF);
  });

  it("alarms once when the day's spend passes the alarm, and says so in Health", async () => {
    await put({ dailySpendAlarmUsd: 0.5 });
    const a = await startRun(h, { email: CUSTOMER });
    const b = await startRun(h, { email: OTHER });
    await close(h, a, { inputTokens: 1_000_000, outputTokens: 100_000 });
    expect(h.mailer.alerts).toHaveLength(1);
    expect(h.mailer.alerts[0]).toMatchObject({ to: "support@fhlostonswarm.com" });
    await close(h, b, { inputTokens: 1_000_000, outputTokens: 100_000 });
    expect(h.mailer.alerts).toHaveLength(1);
    const status = await get<import("@swarm/shared").StaffHealth>("/api/staff/health");
    expect(status.spendToday).toMatchObject({ runs: 2, alarmUsd: 0.5, alarmed: true });
    expect(status.spendToday.usd).toBeGreaterThan(3);
  });
});

describe("the price table", () => {
  it("versions a new table, costs later runs with it and re-prices the earlier ones on request", async () => {
    const early = await startRun(h, { email: CUSTOMER });
    await close(h, early, { inputTokens: 1_000_000, outputTokens: 100_000 });
    const before = await get<CostAnalysis>("/api/staff/costs?test=only");

    const table = { ...pricing, version: "2026-12-01", verified: true };
    table.bedrock = {
      ...pricing.bedrock,
      [SWEEP_MODEL]: { inputPerMTok: 2, outputPerMTok: 10 },
    };
    // A preview shows the effect before anything is saved.
    const preview = await staff.withCsrf("POST", "/api/staff/costs/preview", {
      table,
      test: "only",
    });
    const previewed = (await preview.json()) as CostAnalysis;
    expect(previewed.pricing).toEqual({ mode: "repriced", version: "2026-12-01" });
    expect(previewed.components.bedrockUsd).toBeCloseTo(3, 6);
    expect(previewed.notRepriced).toBe(0);
    expect((await get<{ active: { version: string } }>("/api/staff/pricing")).active.version).toBe(
      pricing.version,
    );

    const saved = await staff.withCsrf("POST", "/api/staff/pricing", {
      table,
      note: "Checked against the AWS price list",
    });
    expect(saved.status).toBe(201);
    expect(
      (await staff.withCsrf("POST", "/api/staff/pricing", { table, note: "again" })).status,
    ).toBe(409);
    const listed = await get<{ active: { version: string }; versions: { version: string }[] }>(
      "/api/staff/pricing",
    );
    expect(listed.active.version).toBe("2026-12-01");
    expect(listed.versions.map((v) => v.version)).toEqual(
      expect.arrayContaining(["2026-12-01", pricing.version]),
    );

    // The earlier run keeps the price it was costed with; a new one uses the new table.
    expect((await get<CostAnalysis>("/api/staff/costs?test=only")).totalUsd).toBeCloseTo(
      before.totalUsd,
      6,
    );
    const later = await startRun(h, { email: OTHER });
    await close(h, later, { inputTokens: 1_000_000, outputTokens: 100_000 });
    const cost = runCostSchema.parse(
      JSON.parse((await h.store.get(keys.runCost(later.owner, later.runId)))!.body),
    );
    expect(cost.pricingVersion).toBe("2026-12-01");
    expect(cost.bedrock.usd).toBeCloseTo(3, 6);

    // Costing everything under one version shows what the old runs would have cost.
    const again = await get<CostAnalysis>(`/api/staff/costs?test=only&pricing=${pricing.version}`);
    expect(again.pricing).toEqual({ mode: "repriced", version: pricing.version });
    expect(again.byTier.sweep.runs).toBe(2);
    expect(again.components.bedrockUsd).toBeCloseTo(3, 6);
    expect((await staff.request("GET", "/api/staff/costs?pricing=nope")).status).toBe(404);
    expect((await get<{ action: string }[]>("/api/staff/audit")).map((a) => a.action)).toContain(
      "set-pricing",
    );
  });

  it("keeps a run recorded before usage was kept as it was costed, and says so", async () => {
    const at = new Date(h.clock.now());
    await h.store.put(
      keys.runIndex(at, "run_0old00000aaaaaaaaaaaa"),
      JSON.stringify({
        test: true,
        runId: "run_0old00000aaaaaaaaaaaa",
        tier: "sweep",
        trigger: "manual",
        entitlement: "credit",
        status: "complete",
        startedAt: at.toISOString(),
        finishedAt: at.toISOString(),
        durationSeconds: 60,
        findings: { total: 1 },
        cost: {
          pricingVersion: "2026-11-11",
          fargateUsd: 0.01,
          egressUsd: 0,
          bedrock: { calls: 1, inputTokens: 1, outputTokens: 1, usd: 0.5 },
          totalUsd: 0.51,
        },
        learner: { modelId: "au.anthropic.claude-opus-4-6-v1", usd: 0.07, seconds: 5 },
      }),
    );
    const recorded = await get<CostAnalysis>("/api/staff/costs?test=only");
    // The learning pass is part of the run's cost, on top of the run's own.
    expect(recorded.totalUsd).toBeCloseTo(0.58, 6);
    expect(recorded.bySource.credit.runs).toBe(1);
    const again = await get<CostAnalysis>(`/api/staff/costs?test=only&pricing=${pricing.version}`);
    expect(again.notRepriced).toBe(1);
    expect(again.totalUsd).toBeCloseTo(0.58, 6);
  });

  it("refuses a table that does not parse", async () => {
    const bad = await staff.withCsrf("POST", "/api/staff/pricing", {
      table: { version: "x" },
      note: "",
    });
    expect(bad.status).toBe(400);
  });
});

describe("health", () => {
  it("lists runs stuck past their time, and reads SES and Bedrock from CloudWatch", async () => {
    const run = await startRun(h);
    h.clock.advance(4 * 3_600_000);
    const asked: string[] = [];
    const reading = createHarness({
      store: h.store,
      now: h.clock.now,
      metrics: {
        read: async ({ namespace, metric }) => {
          asked.push(`${namespace}/${metric}`);
          return metric === "Send"
            ? 200
            : metric === "Bounce"
              ? 2
              : metric === "Complaint"
                ? 0
                : 0.01;
        },
      },
    });
    const viewer = reading.browser("198.51.100.30");
    await reading.signIn(viewer, STAFF);
    const view = (await (
      await viewer.request("GET", "/api/staff/health")
    ).json()) as import("@swarm/shared").StaffHealth;
    expect(view.stuckRuns.map((r) => r.runId)).toEqual([run.runId]);
    expect(view.ses).toMatchObject({ sends: 200, bounces: 2, bounceRate: 0.01, complaints: 0 });
    expect(view.pools.sweep.active).toBe(1);
    expect(view.bedrock).not.toBeNull();
    expect(asked).toContain("AWS/Bedrock/InvocationThrottles");
  });

  it("shows SES as unavailable rather than failing when CloudWatch cannot be read", async () => {
    const view = await get<import("@swarm/shared").StaffHealth>("/api/staff/health");
    expect(view.ses).toBeNull();
    expect(view.killSwitchOn).toBe(false);
  });
});

describe("the learning layer", () => {
  it("rolls back, pins and disables, and turns the layer off, each logged", async () => {
    const view = () => get<import("@swarm/shared").StaffLearning>("/api/staff/learning");
    const first = await view();
    expect(first.version).toBe(1);
    expect(first.items.length).toBeGreaterThan(0);
    const id = first.items[0]!.id;

    const pin = await staff.withCsrf("POST", "/api/staff/learning/entry", {
      kind: "item",
      id,
      pinned: true,
    });
    expect(pin.status).toBe(200);
    const pinned = await view();
    expect(pinned.version).toBe(2);
    expect(pinned.items.find((i) => i.id === id)).toMatchObject({ pinned: true });
    expect(
      (
        await staff.withCsrf("POST", "/api/staff/learning/entry", {
          kind: "item",
          id,
          disabled: true,
        })
      ).status,
    ).toBe(200);
    expect((await view()).items.find((i) => i.id === id)).toMatchObject({
      pinned: true,
      disabled: true,
    });
    expect(
      (
        await staff.withCsrf("POST", "/api/staff/learning/entry", {
          kind: "item",
          id: "k-nothing-here",
          pinned: true,
        })
      ).status,
    ).toBe(404);

    expect(
      (await staff.withCsrf("POST", "/api/staff/learning/pointer", { version: 1 })).status,
    ).toBe(200);
    expect(await view()).toMatchObject({ version: 1 });
    expect(
      (await staff.withCsrf("POST", "/api/staff/learning/pointer", { version: 99 })).status,
    ).toBe(404);

    expect(
      (await staff.withCsrf("POST", "/api/staff/learning/pointer", { enabled: false })).status,
    ).toBe(200);
    expect(await view()).toMatchObject({ killSwitchOn: true });
    expect(
      (
        await staff.withCsrf("POST", "/api/staff/learning/entry", {
          kind: "item",
          id,
          pinned: false,
        })
      ).status,
    ).toBe(409);
    await staff.withCsrf("POST", "/api/staff/learning/pointer", { enabled: true });
    expect(await view()).toMatchObject({ killSwitchOn: false });
    const actions = (await get<{ action: string }[]>("/api/staff/audit")).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["learning-entry", "learning-pointer"]));
  });
});
