import { runCostSchema, runtimeConfig } from "@swarm/shared/server";
import { runEventsPageSchema, runReportSchema, streamTokenSchema } from "@swarm/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { getCredits, grantCredits } from "./credits.js";
import { finalizeRun } from "./finalize.js";
import { emailHash, parseEmail } from "./identity.js";
import { internalApp } from "./internal.js";
import { channelFor } from "./publisher.js";
import { runToken } from "./runtoken.js";
import { keys } from "./storage/keys.js";
import { authorizeAppSync, mintStreamToken } from "./stream.js";
import { createHarness, testSecrets, type Harness, type TestBrowser } from "./testkit.js";

const hashOf = (address: string) => emailHash(testSecrets.pepper, parseEmail(address)!);
const OWNER = "swarm-test-owner@example.com";
const OTHER = "swarm-test-other@example.com";

interface Run {
  h: Harness;
  browser: TestBrowser;
  runId: string;
  owner: string;
  scanId: string;
  /** Calls the agent-facing API as the task would. */
  internal: (
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<Response>;
}

async function setup(
  options: { notifyOn?: "always" | "new" | "never"; notifyEmail?: string; credits?: number } = {},
): Promise<Run> {
  const h = createHarness();
  const browser = h.browser();
  await h.signIn(browser, OWNER);
  const owner = hashOf(OWNER);
  await grantCredits(
    h.store,
    owner,
    { tier: "sweep", count: options.credits ?? 3, source: "comp", reason: "test", by: "tester" },
    h.clock.now(),
  );
  const target = await browser.withCsrf("POST", "/api/targets", {
    appUrl: "https://staging.example.com",
    marketingUrl: "",
    scopeNotes: "",
    logins: { user1: { username: "swarm-test-user1", password: "pw-test-1", description: "User" } },
    acknowledged: true,
  });
  const targetId = ((await target.json()) as { id: string }).id;
  const scan = await browser.withCsrf("POST", "/api/scans", {
    targetId,
    name: "Sweep",
    tier: "sweep",
    frequency: "once",
    timezone: "Australia/Sydney",
    notifyEmail: options.notifyEmail ?? OWNER,
    notifyOn: options.notifyOn ?? "always",
    loginSlots: ["user1"],
  });
  const scanId = ((await scan.json()) as { id: string }).id;
  const run = await browser.withCsrf("POST", `/api/scans/${scanId}/run`);
  const { runId } = (await run.json()) as { runId: string };

  const app = internalApp({
    store: h.store,
    secrets: async () => testSecrets,
    publisher: h.publisher,
    now: h.clock.now,
    requireIam: false,
  });
  const internal: Run["internal"] = (method, path, body, headers = {}) =>
    Promise.resolve(
      app.request(`/api/internal${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-swarm-owner": owner,
          "x-swarm-run": runId,
          "x-swarm-token": runToken(testSecrets, owner, runId),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  return { h, browser, runId, owner, scanId, internal };
}

const start = (r: Run) => r.browser.withCsrf("POST", `/api/runs/${r.runId}/start`);
const summaryOf = async (r: Run) =>
  JSON.parse((await r.h.store.get(keys.runSummary(r.owner, r.runId)))!.body);

let batchCounter = 0;
const batch = (r: Run, events: unknown[]) => ({
  batchId: `batch-${String(++batchCounter).padStart(8, "0")}`,
  events: events.map((e) => ({
    runId: r.runId,
    ts: new Date(r.h.clock.now()).toISOString(),
    ...(e as object),
  })),
});

const finding = (title = "Missing headers") => ({
  id: "F-01",
  title,
  severity: "medium",
  area: "unauth",
  agent: "zap",
  component: "GET /",
  description: "desc",
  remediation: "fix",
  verified: false,
  status: "unverified",
});

const typicalEvents = (): unknown[] => [
  { type: "dispatch", agent: "tls", payload: { task: "Check transport" } },
  {
    type: "start",
    agent: "tls",
    payload: { stepId: "protocols", label: "Negotiate protocol versions" },
  },
  {
    type: "finish",
    agent: "tls",
    payload: {
      outcome: "clear",
      stepId: "protocols",
      label: "Negotiate protocol versions",
      requests: 2,
    },
  },
  { type: "start", agent: "zap", payload: { stepId: "headers", label: "Security headers audit" } },
  {
    type: "finish",
    agent: "zap",
    payload: {
      outcome: "finding",
      stepId: "headers",
      label: "Security headers audit",
      requests: 1,
      finding: finding(),
    },
  },
];

describe("starting and stopping a run", () => {
  let r: Run;
  beforeEach(async () => {
    r = await setup();
  });

  it("starts a queued run once: running, with one execution", async () => {
    const res = await start(r);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "running" });
    expect(r.h.launcher.started).toEqual([{ owner: r.owner, runId: r.runId }]);
    expect((await summaryOf(r)).status).toBe("running");

    const again = await start(r);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "already_started" });
    expect(r.h.launcher.started).toHaveLength(1);
  });

  it("returns the run to queued when the execution cannot be started", async () => {
    r.h.launcher.failStart = true;
    const res = await start(r);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "start_failed" });
    expect((await summaryOf(r)).status).toBe("queued");
    r.h.launcher.failStart = false;
    expect((await start(r)).status).toBe(200);
  });

  it("keeps other accounts out of every run route (404)", async () => {
    const other = r.h.browser("198.51.100.9");
    await r.h.signIn(other, OTHER);
    for (const [method, path] of [
      ["POST", `/api/runs/${r.runId}/start`],
      ["POST", `/api/runs/${r.runId}/stop`],
      ["GET", `/api/runs/${r.runId}/events`],
      ["GET", `/api/runs/${r.runId}/report`],
      ["GET", `/api/runs/${r.runId}/report/link`],
      ["POST", `/api/runs/${r.runId}/stream-token`],
      ["DELETE", `/api/runs/${r.runId}`],
    ] as const) {
      const res = await other.withCsrf(method, path);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect((await summaryOf(r)).status).toBe("queued");
  });

  it("stops a running run: terminates the execution, closes it as stopped and refuses more events", async () => {
    await start(r);
    await r.internal("POST", "/events", batch(r, typicalEvents()));
    const res = await r.browser.withCsrf("POST", `/api/runs/${r.runId}/stop`);
    expect(await res.json()).toEqual({ ok: true, status: "stopped" });
    expect(r.h.launcher.stopped).toEqual([{ owner: r.owner, runId: r.runId }]);

    const summary = await summaryOf(r);
    expect(summary).toMatchObject({ status: "stopped" });
    expect(summary.reason).toMatch(/Stopped/);
    expect(summary.finishedAt).toBeDefined();
    // A partial report exists, and the credit is not returned for a stop the customer asked for.
    const report = runReportSchema.parse(
      await (await r.browser.request("GET", `/api/runs/${r.runId}/report`)).json(),
    );
    expect(report.status).toBe("stopped");
    expect(report.findings).toHaveLength(1);
    expect((await getCredits(r.h.store, r.owner)).sweep).toBe(2);

    const late = await r.internal("POST", "/events", batch(r, typicalEvents()));
    expect(late.status).toBe(409);
    // A second stop is refused, not repeated.
    expect((await r.browser.withCsrf("POST", `/api/runs/${r.runId}/stop`)).status).toBe(409);
  });

  it("will not stop a run that has not started", async () => {
    const res = await r.browser.withCsrf("POST", `/api/runs/${r.runId}/stop`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_running" });
  });

  it("stops a running run before deleting it, and keeps only the anonymised index", async () => {
    await start(r);
    await r.internal("POST", "/events", batch(r, typicalEvents()));
    const res = await r.browser.withCsrf("DELETE", `/api/runs/${r.runId}`);
    expect(res.status).toBe(200);
    expect(r.h.launcher.stopped).toHaveLength(1);
    expect(await r.h.store.list(keys.runPrefix(r.owner, r.runId))).toEqual([]);
    const index = (await r.h.store.list("admin/run-index/")).filter((k) =>
      k.endsWith(`${r.runId}.json`),
    );
    expect(index).toHaveLength(1);
  });

  it("stops running runs when the account is deleted", async () => {
    await start(r);
    await r.browser.withCsrf("POST", "/api/account/delete-code");
    const code = r.h.mailer.lastDeletionCodeTo(OWNER)!.code;
    const res = await r.browser.withCsrf("DELETE", "/api/account", { code });
    expect(res.status).toBe(200);
    expect(r.h.launcher.stopped).toHaveLength(1);
    expect(await r.h.store.list(keys.userPrefix(r.owner))).toEqual([]);
  });
});

describe("the agent-facing API", () => {
  let r: Run;
  beforeEach(async () => {
    r = await setup();
    await start(r);
  });

  it("is closed to anything but the right owner, run and token", async () => {
    const ok = await r.internal("GET", "/input");
    expect(ok.status).toBe(200);
    for (const headers of [
      { "x-swarm-token": "wrong" },
      { "x-swarm-token": "" },
      { "x-swarm-run": "run_other0001" },
      { "x-swarm-owner": hashOf(OTHER) },
      { "x-swarm-owner": "not-a-hash" },
    ] as Record<string, string>[]) {
      const res = await r.internal("GET", "/input", undefined, headers);
      expect(res.status, JSON.stringify(headers)).toBe(403);
    }
  });

  it("refuses requests that did not come through IAM when it is required", async () => {
    const app = internalApp({
      store: r.h.store,
      secrets: async () => testSecrets,
      now: r.h.clock.now,
      requireIam: true,
    });
    const res = await app.request("/api/internal/input", {
      headers: {
        "x-swarm-owner": r.owner,
        "x-swarm-run": r.runId,
        "x-swarm-token": runToken(testSecrets, r.owner, r.runId),
      },
    });
    expect(res.status).toBe(403);
  });

  it("tells the agent its scope, budgets and logins", async () => {
    const input = (await (await r.internal("GET", "/input")).json()) as {
      agents: string[];
      budgets: { maxRequests: number };
      userAgent: string;
    };
    expect(input).toMatchObject({
      runId: r.runId,
      tier: "sweep",
      target: { appUrl: "https://staging.example.com" },
      scope: { hosts: ["staging.example.com"], ports: [80, 443], readOnly: true },
      logins: { user1: { username: "swarm-test-user1", password: "pw-test-1" } },
    });
    expect(input.agents).toContain("tls");
    expect(input.budgets.maxRequests).toBeGreaterThan(0);
    expect(input.userAgent).toMatch(/^Swarm\//);
  });

  it("gives events their seq in arrival order, folds them into the summary and publishes them", async () => {
    const res = await r.internal("POST", "/events", batch(r, typicalEvents()));
    expect(await res.json()).toEqual({ lastSeq: 5, duplicate: false });
    const second = await r.internal(
      "POST",
      "/events",
      batch(r, [{ type: "agent-done", agent: "tls", payload: { summary: "done" } }]),
    );
    expect(await second.json()).toEqual({ lastSeq: 6, duplicate: false });

    const page = runEventsPageSchema.parse(
      await (await r.browser.request("GET", `/api/runs/${r.runId}/events`)).json(),
    );
    expect(page.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(page.lastSeq).toBe(6);
    expect(r.h.publisher.published.map((p) => p.event.seq)).toEqual([1, 2, 3, 4, 5, 6]);

    const summary = await summaryOf(r);
    expect(summary).toMatchObject({
      status: "running",
      checks: 2,
      requests: 3,
      findings: { total: 1 },
    });
    expect(summary.agents.done).toBe(1);
  });

  it("applies a retried batch once", async () => {
    const body = batch(r, typicalEvents());
    await r.internal("POST", "/events", body);
    const retry = await r.internal("POST", "/events", body);
    expect(await retry.json()).toEqual({ lastSeq: 5, duplicate: true });
    const page = runEventsPageSchema.parse(
      await (await r.browser.request("GET", `/api/runs/${r.runId}/events`)).json(),
    );
    expect(page.events).toHaveLength(5);
    expect(new Set(page.events.map((e) => e.seq)).size).toBe(5);
  });

  it("pages the log with ?after=", async () => {
    await r.internal("POST", "/events", batch(r, typicalEvents()));
    const page = runEventsPageSchema.parse(
      await (await r.browser.request("GET", `/api/runs/${r.runId}/events?after=3`)).json(),
    );
    expect(page.events.map((e) => e.seq)).toEqual([4, 5]);
    const none = runEventsPageSchema.parse(
      await (await r.browser.request("GET", `/api/runs/${r.runId}/events?after=5`)).json(),
    );
    expect(none).toMatchObject({ events: [], lastSeq: 5, more: false });
  });

  it("rejects events for another run, invalid events, and events an agent may not send", async () => {
    const wrong = {
      batchId: "batch-wrongrun",
      events: [
        {
          runId: "run_other0001",
          ts: new Date().toISOString(),
          type: "dispatch",
          agent: "tls",
          payload: { task: "x" },
        },
      ],
    };
    expect((await r.internal("POST", "/events", wrong)).status).toBe(400);
    expect((await r.internal("POST", "/events", { batchId: "x", events: [] })).status).toBe(400);
    const complete = batch(r, [{ type: "complete", agent: null, payload: { summary: {} } }]);
    expect((await r.internal("POST", "/events", complete)).status).toBe(400);
    expect((await r.internal("POST", "/evidence", { name: "other", body: {} })).status).toBe(400);
    const page = runEventsPageSchema.parse(
      await (await r.browser.request("GET", `/api/runs/${r.runId}/events`)).json(),
    );
    expect(page.events).toEqual([]);
  });

  it("stores evidence under the run, with the test marker", async () => {
    const res = await r.internal("POST", "/evidence", {
      name: "proxy-stats",
      body: { uptimeSeconds: 12, requests: 5, blocked: 0, bytesOut: 100, bytesIn: 900 },
    });
    expect(res.status).toBe(200);
    const stored = JSON.parse(
      (await r.h.store.get(keys.runEvidence(r.owner, r.runId, "proxy-stats")))!.body,
    );
    expect(stored).toMatchObject({ requests: 5, test: true });
  });
});

describe("closing a run", () => {
  it("writes the report, cost and an anonymised index, and tells the notification address", async () => {
    const r = await setup();
    await start(r);
    await r.internal("POST", "/events", batch(r, typicalEvents()));
    await r.internal("POST", "/evidence", {
      name: "proxy-stats",
      body: { uptimeSeconds: 90, requests: 3, blocked: 0, bytesOut: 2048, bytesIn: 50_000 },
    });
    const deps = {
      store: r.h.store,
      mailer: r.h.mailer,
      publisher: r.h.publisher,
      now: r.h.clock.now,
      siteOrigin: "https://fhlostonswarm.com",
    };
    r.h.clock.advance(120_000);
    const closed = await finalizeRun(
      deps,
      { emailHash: r.owner, runId: r.runId },
      { kind: "finished" },
    );
    expect(closed).toMatchObject({ status: "complete", checks: 2, findings: { total: 1 } });

    // The last event is `complete`, with the final summary.
    const page = runEventsPageSchema.parse(
      await (await r.browser.request("GET", `/api/runs/${r.runId}/events`)).json(),
    );
    const last = page.events.at(-1)!;
    expect(last.type).toBe("complete");
    expect(last.type === "complete" && last.payload.summary.status).toBe("complete");

    const report = runReportSchema.parse(
      await (await r.browser.request("GET", `/api/runs/${r.runId}/report`)).json(),
    );
    expect(report.findings.map((f) => f.title)).toEqual(["Missing headers"]);
    expect(report.passed.map((p) => p.stepId)).toContain("protocols");
    // Agents in the tier that never ran are listed, with a reason.
    expect(report.notRun.length).toBeGreaterThan(0);

    const cost = runCostSchema.parse(
      JSON.parse((await r.h.store.get(keys.runCost(r.owner, r.runId)))!.body),
    );
    expect(cost.fargate.taskSeconds).toBeGreaterThanOrEqual(60);
    expect(cost.egress.bytesOut).toBe(2048);
    expect(cost.bedrock).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 });
    expect(cost.totalUsd).toBeGreaterThan(0);

    const indexKey = (await r.h.store.list("admin/run-index/")).find((k) =>
      k.endsWith(`${r.runId}.json`),
    )!;
    const index = (await r.h.store.get(indexKey))!.body;
    for (const secret of [
      OWNER,
      r.owner,
      "staging.example.com",
      "Missing headers",
      "swarm-test-user1",
    ]) {
      expect(index).not.toContain(secret);
    }
    expect(JSON.parse(index)).toMatchObject({ tier: "sweep", status: "complete", test: true });

    expect(r.h.mailer.reports).toEqual([
      expect.objectContaining({
        to: OWNER,
        findings: 1,
        link: `https://fhlostonswarm.com/runs/${r.runId}/report`,
      }),
    ]);

    // Cost never reaches anything the customer can read.
    const customerFacing = JSON.stringify([
      await (await r.browser.request("GET", `/api/runs/${r.runId}`)).json(),
      page,
      report,
    ]);
    expect(customerFacing).not.toMatch(/usd|fargate|pricing/i);
  });

  it("is idempotent: closing twice sends one notice and writes one complete event", async () => {
    const r = await setup();
    await start(r);
    await r.internal("POST", "/events", batch(r, typicalEvents()));
    const deps = {
      store: r.h.store,
      mailer: r.h.mailer,
      publisher: r.h.publisher,
      now: r.h.clock.now,
      siteOrigin: "https://fhlostonswarm.com",
    };
    await finalizeRun(deps, { emailHash: r.owner, runId: r.runId }, { kind: "finished" });
    await finalizeRun(deps, { emailHash: r.owner, runId: r.runId }, { kind: "finished" });
    expect(r.h.mailer.reports).toHaveLength(1);
    const page = runEventsPageSchema.parse(
      await (await r.browser.request("GET", `/api/runs/${r.runId}/events`)).json(),
    );
    expect(page.events.filter((e) => e.type === "complete")).toHaveLength(1);
  });

  it.each([
    ["never", "swarm-test-owner@example.com", 0],
    ["new", "swarm-test-owner@example.com", 1],
  ] as const)(
    "notify %s sends %i notice(s) when there is a finding",
    async (notifyOn, email, count) => {
      const r = await setup({ notifyOn, notifyEmail: email });
      await start(r);
      await r.internal("POST", "/events", batch(r, typicalEvents()));
      await finalizeRun(
        {
          store: r.h.store,
          mailer: r.h.mailer,
          now: r.h.clock.now,
          siteOrigin: "https://fhlostonswarm.com",
        },
        { emailHash: r.owner, runId: r.runId },
        { kind: "finished" },
      );
      expect(r.h.mailer.reports).toHaveLength(count);
    },
  );

  it("sends nothing to a notification address that has not confirmed", async () => {
    const r = await setup({ notifyEmail: "swarm-test-third@example.com" });
    await start(r);
    await finalizeRun(
      {
        store: r.h.store,
        mailer: r.h.mailer,
        now: r.h.clock.now,
        siteOrigin: "https://fhlostonswarm.com",
      },
      { emailHash: r.owner, runId: r.runId },
      { kind: "finished" },
    );
    expect(r.h.mailer.reports).toEqual([]);
  });

  it("returns the credit once when a run fails on our side, with a partial report", async () => {
    const r = await setup({ credits: 1 });
    await start(r);
    expect((await getCredits(r.h.store, r.owner)).sweep).toBe(0);
    await r.internal("POST", "/events", batch(r, typicalEvents()));
    const deps = {
      store: r.h.store,
      mailer: r.h.mailer,
      now: r.h.clock.now,
      siteOrigin: "https://fhlostonswarm.com",
    };
    const closed = await finalizeRun(
      deps,
      { emailHash: r.owner, runId: r.runId },
      { kind: "failed" },
    );
    expect(closed).toMatchObject({ status: "failed" });
    expect(closed?.reason).toMatch(/credit has been returned/);
    expect((await getCredits(r.h.store, r.owner)).sweep).toBe(1);
    await finalizeRun(deps, { emailHash: r.owner, runId: r.runId }, { kind: "failed" });
    expect((await getCredits(r.h.store, r.owner)).sweep).toBe(1);
    expect(r.h.mailer.reports).toEqual([]);
  });

  it("does nothing for a run that is gone", async () => {
    const r = await setup();
    await r.h.store.delete(keys.runSummary(r.owner, r.runId));
    const closed = await finalizeRun(
      { store: r.h.store, mailer: r.h.mailer, now: r.h.clock.now, siteOrigin: "https://x.test" },
      { emailHash: r.owner, runId: r.runId },
      { kind: "failed" },
    );
    expect(closed).toBeNull();
  });
});

describe("the report", () => {
  it("escapes everything that came from the run", async () => {
    const r = await setup();
    await start(r);
    const nasty = "<script>alert(1)</script><img src=x onerror=alert(2)>";
    await r.internal(
      "POST",
      "/events",
      batch(r, [
        {
          type: "start",
          agent: "zap",
          payload: { stepId: "headers", label: "Security headers audit" },
        },
        {
          type: "finish",
          agent: "zap",
          payload: {
            outcome: "finding",
            stepId: "headers",
            label: "Security headers audit",
            requests: 1,
            finding: { ...finding(nasty), component: nasty, description: nasty },
          },
        },
      ]),
    );
    await finalizeRun(
      { store: r.h.store, mailer: r.h.mailer, now: r.h.clock.now, siteOrigin: "https://x.test" },
      { emailHash: r.owner, runId: r.runId },
      { kind: "finished" },
    );
    const html = (await r.h.store.get(keys.runReportHtml(r.owner, r.runId)))!.body;
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("automated, AI-assisted");
  });

  it("is served by an authenticated, time-limited link, only once it exists", async () => {
    const r = await setup();
    await start(r);
    expect((await r.browser.request("GET", `/api/runs/${r.runId}/report/link`)).status).toBe(404);
    expect((await r.browser.request("GET", `/api/runs/${r.runId}/report`)).status).toBe(404);
    await finalizeRun(
      { store: r.h.store, mailer: r.h.mailer, now: r.h.clock.now, siteOrigin: "https://x.test" },
      { emailHash: r.owner, runId: r.runId },
      { kind: "finished" },
    );
    const res = await r.browser.request("GET", `/api/runs/${r.runId}/report/link`);
    const link = (await res.json()) as { url: string; expiresAt: string };
    expect(link.url).toContain(keys.runReportHtml(r.owner, r.runId));
    expect(link.url).toContain("swarm-report-");
    expect(Date.parse(link.expiresAt)).toBe(r.h.clock.now() + 300_000);
    const anonymous = await r.h
      .browser("198.51.100.20")
      .request("GET", `/api/runs/${r.runId}/report/link`);
    expect(anonymous.status).toBe(401);
  });
});

describe("the live channel", () => {
  it("mints a short-lived token for one run, and the authorizer honours exactly that", async () => {
    const r = await setup();
    const res = await r.browser.withCsrf("POST", `/api/runs/${r.runId}/stream-token`);
    const stream = streamTokenSchema.parse(await res.json());
    expect(stream).toMatchObject({
      realtimeUrl: "wss://rt.test/event/realtime",
      host: "http.test",
      channel: channelFor(r.runId),
    });
    expect(Date.parse(stream.expiresAt)).toBe(
      r.h.clock.now() + runtimeConfig.streamTokenMinutes * 60_000,
    );

    const ask = (operation: string, channel: string, token = stream.token, at = r.h.clock.now()) =>
      authorizeAppSync(
        testSecrets,
        { authorizationToken: token, requestContext: { operation, channel } },
        at,
      );
    expect((await ask("EVENT_CONNECT", "")).isAuthorized).toBe(true);
    expect((await ask("EVENT_SUBSCRIBE", channelFor(r.runId))).isAuthorized).toBe(true);
    expect((await ask("EVENT_SUBSCRIBE", "/runs/run_someoneelse")).isAuthorized).toBe(false);
    expect((await ask("EVENT_PUBLISH", channelFor(r.runId))).isAuthorized).toBe(false);
    expect((await ask("EVENT_CONNECT", "", "garbage")).isAuthorized).toBe(false);
    expect(
      (await ask("EVENT_CONNECT", "", stream.token, r.h.clock.now() + 3600_000)).isAuthorized,
    ).toBe(false);
    // A session token is not a stream token.
    const access = r.browser.cookie("__Host-swarm_at")!;
    expect((await ask("EVENT_SUBSCRIBE", channelFor(r.runId), access)).isAuthorized).toBe(false);
    const other = await mintStreamToken(
      testSecrets,
      { runId: "run_other0001", emailHash: r.owner },
      r.h.clock.now(),
    );
    expect((await ask("EVENT_SUBSCRIBE", channelFor(r.runId), other.token)).isAuthorized).toBe(
      false,
    );
  });

  it("says streaming is unavailable when there is no channel (local dev)", async () => {
    const h = createHarness({ stream: undefined });
    const b = h.browser();
    await h.signIn(b, OWNER);
    const res = await b.withCsrf("POST", "/api/runs/run_abcdefgh/stream-token");
    expect(res.status).toBe(404);
  });
});
