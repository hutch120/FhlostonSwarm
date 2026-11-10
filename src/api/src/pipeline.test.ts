import type { AddressInfo } from "node:net";
import type http from "node:http";
import { PlaywrightDriver, chromiumAvailable, createOfflineLlm } from "@swarm/agents";
import { runEventsPageSchema, runReportSchema, TERMS_VERSION, tiers } from "@swarm/shared";
import { limitsFor } from "@swarm/shared/server";
import expected from "@swarm/synthetic-target/expected.json" with { type: "json" };
import { createTarget, USERS } from "@swarm/synthetic-target";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getCredits, grantCredits } from "./credits.js";
import { emailHash, parseEmail } from "./identity.js";
import { LocalLauncher } from "./local-launcher.js";
import { acquireSlot, releaseSlot } from "./pool.js";
import { keys } from "./storage/keys.js";
import { putJson } from "./storage/json.js";
import { createHarness, testSecrets, type Harness, type TestBrowser } from "./testkit.js";

/**
 * The whole pipeline in one process: a run started through the API is executed by the real agent
 * (behind the real scope proxy) against the synthetic target, its events go through the internal API
 * into the log and the live channel, and the run is closed with a report. Only AWS is replaced.
 */
// Every run launches Chromium for the explorer.
vi.setConfig({ testTimeout: 60_000 });
const browserAvailable = await chromiumAvailable();

const OWNER = "swarm-test-pipeline@example.com";
const owner = emailHash(testSecrets.pepper, parseEmail(OWNER)!);

let server: http.Server;
let port: number;
beforeAll(async () => {
  server = createTarget();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function setup(tier: "scout" | "sweep", appUrl = () => `http://127.0.0.1:${port}/`) {
  // The harness needs the launcher and the launcher needs the harness's store: tie them with a box.
  const box: { launcher?: LocalLauncher } = {};
  const h: Harness = createHarness({
    launcher: {
      start: (o, r) => box.launcher!.start(o, r),
      stop: (o, r) => box.launcher!.stop(o, r),
    },
  });
  const launcher = new LocalLauncher({
    store: h.store,
    secrets: async () => testSecrets,
    publisher: h.publisher,
    allowPrivate: true,
    llm: () => createOfflineLlm(),
    driverFactory: (options) => PlaywrightDriver.launch(options),
    pollMs: 20,
    now: h.clock.now,
    finalize: {
      store: h.store,
      mailer: h.mailer,
      publisher: h.publisher,
      now: h.clock.now,
      siteOrigin: "https://fhlostonswarm.com",
    },
  });
  box.launcher = launcher;
  const browser: TestBrowser = h.browser();
  await h.signIn(browser, OWNER);
  await grantCredits(
    h.store,
    owner,
    { tier, count: 2, source: "comp", reason: "test", by: "t" },
    h.clock.now(),
  );

  // The intake refuses loopback addresses, so the target is saved directly.
  const at = h.clock.now();
  const user = USERS[1]!;
  const url = appUrl();
  const host = new URL(url).hostname;
  await putJson(h.store, keys.target(owner, "tgt_pipeline01"), {
    test: true,
    id: "tgt_pipeline01",
    appUrl: url,
    marketingUrl: "",
    scopeNotes: "",
    hosts: [host],
    logins: {
      user1: { username: user.username, password: user.password, description: "User", notes: "" },
    },
    acknowledgement: { at, ip: "127.0.0.1", termsVersion: TERMS_VERSION },
    createdAt: at,
    updatedAt: at,
  });
  const scan = await browser.withCsrf("POST", "/api/scans", {
    targetId: "tgt_pipeline01",
    name: "Pipeline",
    tier,
    frequency: "once",
    timezone: "Australia/Sydney",
    notifyEmail: OWNER,
    notifyOn: "always",
    loginSlots: tier === "scout" ? [] : ["user1"],
  });
  expect(scan.status, await scan.clone().text()).toBe(201);
  const scanId = ((await scan.json()) as { id: string }).id;
  const created = await browser.withCsrf("POST", `/api/scans/${scanId}/run`);
  const { runId } = (await created.json()) as { runId: string };
  return { h, browser, launcher, runId };
}

describe.skipIf(!browserAvailable)("a run, end to end", () => {
  it("runs the agent against the synthetic target and closes with the expected findings", async () => {
    const { h, browser, launcher, runId } = await setup("sweep");
    expect((await browser.withCsrf("POST", `/api/runs/${runId}/start`)).status).toBe(200);
    await launcher.settled(runId);

    const run = (await (await browser.request("GET", `/api/runs/${runId}`)).json()) as {
      summary: {
        status: string;
        findings: { total: number };
        coverage: number;
        agents: { total: number; done: number };
      };
    };
    expect(run.summary.status).toBe("complete");
    // Sweep signs in as the non-admin customer here, so the findings are the ones the whole group
    // raises that do not depend on the administrator login.
    const want = expected.findings.filter((f) => tiers.sweep.agents.includes(f.agent));
    expect(run.summary.findings.total).toBe(want.length);
    expect(run.summary.agents).toEqual({ total: 7, done: 7 });
    expect(run.summary.coverage).toBeGreaterThan(0.8);

    const page = runEventsPageSchema.parse(
      await (await browser.request("GET", `/api/runs/${runId}/events`)).json(),
    );
    expect(page.events.map((e) => e.seq)).toEqual(page.events.map((_, i) => i + 1));
    expect(page.events.at(-1)?.type).toBe("complete");
    // Everything in the log was also published to the live channel, in order.
    expect(h.publisher.published.map((p) => p.event.seq)).toEqual(page.events.map((e) => e.seq));

    const report = runReportSchema.parse(
      await (await browser.request("GET", `/api/runs/${runId}/report`)).json(),
    );
    for (const w of want) {
      const got = report.findings.find(
        (f) => f.agent === w.agent && f.title.includes(w.titleIncludes),
      );
      expect(got, `${w.agent}: ${w.titleIncludes}`).toBeDefined();
      expect(got!.severity).toBe(w.severity);
    }
    // The checks a read-only, outside-in scan cannot make are listed, not hidden.
    expect(report.gaps.map((g) => g.agent).sort()).toEqual(["authn", "dns", "dns"]);
    // The deeper agents are listed as not included at this depth, and the app profile is filled in.
    expect(report.notIncluded.map((n) => n.agent).sort()).toEqual([
      "authz",
      "idor",
      "output",
      "prompt",
      "session",
    ]);
    expect(report.profile?.coverage.signedIn).toBe(true);
    expect(report.profile?.areas.length).toBeGreaterThan(4);

    // The agent's requests went through the proxy, which logged them as evidence.
    const log = JSON.parse((await h.store.get(keys.runEvidence(owner, runId, "proxy-log")))!.body);
    expect(log.entries.length).toBeGreaterThanOrEqual(8);
    // The one write the proxy let through is the sign-in.
    const writes = log.entries.filter((e: { method: string }) => e.method === "POST");
    expect(writes.filter((w: { decision: string }) => w.decision === "allowed")).toHaveLength(1);

    // The model's usage is in the cost record, and not in anything the customer sees.
    const cost = JSON.parse((await h.store.get(keys.runCost(owner, runId)))!.body);
    expect(cost.bedrock.calls).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toMatch(/bedrock|"usd"|inputTokens|modelId/i);

    expect((await getCredits(h.store, owner)).sweep).toBe(1);
    expect(h.mailer.reports).toHaveLength(1);
  });

  it("only runs the agents the depth names (Scout)", async () => {
    const { browser, launcher, runId } = await setup("scout");
    await browser.withCsrf("POST", `/api/runs/${runId}/start`);
    await launcher.settled(runId);
    const report = runReportSchema.parse(
      await (await browser.request("GET", `/api/runs/${runId}/report`)).json(),
    );
    expect(new Set(report.findings.map((f) => f.agent))).toEqual(
      new Set(["surface", "tls", "cors"]),
    );
    expect(report.summary.agents.total).toBe(4);
    // Scout never signs in: the signed-in agents are "not included", and the profile is public only.
    expect(report.notIncluded.map((n) => n.agent)).toContain("authn");
    expect(report.profile?.coverage.signedIn).toBe(false);
  });

  it("queues a run when its depth's pool is full, tells the customer, and starts it when a slot frees", async () => {
    const { h, browser, launcher, runId } = await setup("scout");
    // Fill the Scout pool with other runs.
    const limit = limitsFor("scout").concurrency;
    for (let i = 0; i < limit; i++) {
      await acquireSlot(h.store, {
        tier: "scout",
        runId: `busy_${i}`,
        test: true,
        now: h.clock.now(),
      });
    }
    await browser.withCsrf("POST", `/api/runs/${runId}/start`);
    await vi.waitFor(async () => {
      const run = (await (await browser.request("GET", `/api/runs/${runId}`)).json()) as {
        summary: { status: string };
        reason?: string;
      };
      expect(run.summary.status).toBe("queued");
      expect(run.reason).toMatch(/Waiting for a free Scout slot/);
    });

    // A slot frees: the waiting run starts by itself and completes.
    await releaseSlot(h.store, { tier: "scout", runId: "busy_0", test: true });
    await launcher.settled(runId);
    const done = (await (await browser.request("GET", `/api/runs/${runId}`)).json()) as {
      summary: { status: string };
      reason?: string;
    };
    expect(done.summary.status).toBe("complete");
    expect(done.reason).toBeUndefined();
    // Its slot went back when it finished: the pool holds only the others.
    const pool = JSON.parse((await h.store.get(keys.pool("scout", true)))!.body);
    expect(Object.keys(pool.active).sort()).toEqual(["busy_1", "busy_2", "busy_3"]);
  });

  it("returns the credit when the customer cancels a run that is still waiting", async () => {
    const { h, browser, launcher, runId } = await setup("scout");
    const limit = limitsFor("scout").concurrency;
    for (let i = 0; i < limit; i++) {
      await acquireSlot(h.store, {
        tier: "scout",
        runId: `busy_${i}`,
        test: true,
        now: h.clock.now(),
      });
    }
    await browser.withCsrf("POST", `/api/runs/${runId}/start`);
    await vi.waitFor(async () => {
      const run = (await (await browser.request("GET", `/api/runs/${runId}`)).json()) as {
        reason?: string;
      };
      expect(run.reason).toMatch(/Waiting/);
    });
    expect((await getCredits(h.store, owner)).scout).toBe(1);

    const stopped = await browser.withCsrf("POST", `/api/runs/${runId}/stop`);
    expect(await stopped.json()).toEqual({ ok: true, status: "stopped" });
    await launcher.settled(runId);
    expect((await getCredits(h.store, owner)).scout).toBe(2);
    const summary = JSON.parse((await h.store.get(keys.runSummary(owner, runId)))!.body);
    expect(summary).toMatchObject({ status: "stopped" });
    // It never held a slot, and the others are untouched.
    const pool = JSON.parse((await h.store.get(keys.pool("scout", true)))!.body);
    expect(Object.keys(pool.waiting)).toEqual([]);
    expect(Object.keys(pool.active)).toHaveLength(limit);
  });

  it("closes as stopped when the customer stops it, and nothing is left running", async () => {
    const { h, browser, launcher, runId } = await setup("sweep");
    await browser.withCsrf("POST", `/api/runs/${runId}/start`);
    const res = await browser.withCsrf("POST", `/api/runs/${runId}/stop`);
    expect(await res.json()).toEqual({ ok: true, status: "stopped" });
    await launcher.settled(runId);
    const summary = JSON.parse((await h.store.get(keys.runSummary(owner, runId)))!.body);
    expect(summary.status).toBe("stopped");
    const report = runReportSchema.parse(
      await (await browser.request("GET", `/api/runs/${runId}/report`)).json(),
    );
    expect(report.status).toBe("stopped");
  });

  it("completes with gaps, not a failure, when the target cannot be reached", async () => {
    // Nothing listens on this port.
    const { browser, launcher, runId, h } = await setup("scout", () => "http://127.0.0.1:9/");
    await browser.withCsrf("POST", `/api/runs/${runId}/start`);
    await launcher.settled(runId);
    const report = runReportSchema.parse(
      await (await browser.request("GET", `/api/runs/${runId}/report`)).json(),
    );
    expect(report.status).toBe("complete");
    expect(report.findings).toEqual([]);
    expect(report.gaps.length).toBeGreaterThan(3);
    expect((await getCredits(h.store, owner)).scout).toBe(1);
  });
});
