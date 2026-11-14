import type { AddressInfo } from "node:net";
import type http from "node:http";
import { PlaywrightDriver, chromiumAvailable, createOfflineLlm, renderPdf } from "@swarm/agents";
import type { FetchLike, LlmClient } from "@swarm/agents/learning";
import { runEventsPageSchema, runReportSchema, TERMS_VERSION, tiers } from "@swarm/shared";
import {
  engagementSchema,
  INSTRUCTIONS_VERSION,
  learningConfig,
  limitsFor,
} from "@swarm/shared/server";
import expected from "@swarm/synthetic-target/expected.json" with { type: "json" };
import { createTarget, USERS } from "@swarm/synthetic-target";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getCredits, grantCredits } from "./credits.js";
import { emailHash, parseEmail } from "./identity.js";
import { learnFromRun } from "./learning.js";
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

const DEEP_SLOTS = ["admin", "user1", "user2"] as const;

/** The learner's model: it proposes nothing, so these tests see the pass's bookkeeping and cost only. */
const learnerModel = (): LlmClient => ({
  modelId: learningConfig.learnerModelId,
  async converse() {
    return {
      message: {
        role: "assistant",
        content: [{ type: "toolUse", id: "learn1", name: "record_learning", input: {} }],
      },
      stopReason: "tool_use",
      usage: { inputTokens: 5000, outputTokens: 200 },
    };
  },
});

/** The allow-listed sources, served from memory. */
const sourceStub: FetchLike = async (url) => {
  const kev = url.includes("known_exploited");
  const res = new Response(
    kev
      ? JSON.stringify({ vulnerabilities: [] })
      : "<html><body><p>Risk categories.</p></body></html>",
    { status: 200, headers: { "content-type": kev ? "application/json" : "text/html" } },
  );
  Object.defineProperty(res, "url", { value: url });
  return res;
};

async function setup(
  tier: "scout" | "sweep" | "probe" | "siege",
  appUrl = () => `http://127.0.0.1:${port}/`,
) {
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
    renderPdf,
    learn: (ids) =>
      learnFromRun(
        { store: h.store, llm: learnerModel(), fetch: sourceStub, now: h.clock.now },
        ids,
      ),
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
  const url = appUrl();
  const host = new URL(url).hostname;
  const deep = tier === "probe" || tier === "siege";
  const login = (username: string, password: string, description: string) => ({
    username,
    password,
    description,
    notes: "",
  });
  const logins = deep
    ? Object.fromEntries(
        (tier === "probe" ? DEEP_SLOTS.slice(0, 2) : DEEP_SLOTS).map((slot) => {
          const u = USERS.find((x) => x.username === `swarm-test-${slot}`)!;
          return [
            slot,
            login(
              u.username,
              u.password,
              slot === "admin" ? "Administrator" : `Customer ${slot.slice(-1)}`,
            ),
          ];
        }),
      )
    : { user1: login(USERS[1]!.username, USERS[1]!.password, "User") };
  await putJson(h.store, keys.target(owner, "tgt_pipeline01"), {
    test: true,
    id: "tgt_pipeline01",
    appUrl: url,
    marketingUrl: "",
    scopeNotes: "",
    hosts: [host],
    logins,
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
    loginSlots: tier === "scout" ? [] : Object.keys(logins),
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

describe.skipIf(!browserAvailable)("a Siege run, end to end", () => {
  vi.setConfig({ testTimeout: 120_000 });

  it("plans, tests across roles, verifies, and closes with the full report in HTML, PDF and JSON", async () => {
    const { h, browser, launcher, runId } = await setup("siege");
    expect((await browser.withCsrf("POST", `/api/runs/${runId}/start`)).status).toBe(200);
    await launcher.settled(runId);

    const run = (await (await browser.request("GET", `/api/runs/${runId}`)).json()) as {
      summary: { status: string; findings: { total: number; verified: number }; agents: object };
    };
    expect(run.summary.status).toBe("complete");
    expect(run.summary.agents).toEqual({ total: 12, done: 12 });

    // The report: every seeded issue, each independently verified.
    const report = runReportSchema.parse(
      await (await browser.request("GET", `/api/runs/${runId}/report`)).json(),
    );
    const want = expected.findings.filter((f) => tiers.siege.agents.includes(f.agent));
    for (const w of want) {
      expect(
        report.findings.find((f) => f.agent === w.agent && f.title.includes(w.titleIncludes)),
        `${w.agent}: ${w.titleIncludes}`,
      ).toBeDefined();
    }
    expect(report.counts.verified).toBe(report.counts.total);
    expect(report.counts.unconfirmed).toBe(0);
    expect(report.findings.every((f) => f.verification.checked)).toBe(true);
    expect(report.ai.status).toBe("tested");
    expect(report.plan?.roles.map((r) => r.slot)).toEqual(["admin", "user1", "user2"]);
    expect(report.instructionsVersion).toBe(INSTRUCTIONS_VERSION);

    // The plan is private evidence; the version is also in the anonymised run index.
    const plan = engagementSchema.parse(
      JSON.parse((await h.store.get(keys.runEvidence(owner, runId, "engagement")))!.body),
    );
    expect(plan.instructionsVersion).toBe(INSTRUCTIONS_VERSION);
    const indexKey = (await h.store.list("admin/run-index/")).find((k) =>
      k.endsWith(`${runId}.json`),
    )!;
    expect(JSON.parse((await h.store.get(indexKey))!.body)).toMatchObject({
      instructionsVersion: INSTRUCTIONS_VERSION,
      dynamicVersion: 1,
      verification: { verified: report.counts.verified, unconfirmed: 0 },
    });

    // The run was pinned to a version of the learned layer when its task asked for its input (the
    // test account's own layer, so no customer run depends on a test), and the report names it.
    expect(plan.dynamic.version).toBe(1);
    expect(report.dynamic).toMatchObject({ version: 1 });
    const pin = JSON.parse((await h.store.get(keys.runDynamic(owner, runId)))!.body);
    expect(pin).toMatchObject({ test: true, layer: { version: 1 } });
    expect(await h.store.get("learning/current.json")).toBeNull();
    expect(JSON.parse((await h.store.get("learning/test/current.json"))!.body)).toMatchObject({
      version: 1,
      enabled: true,
    });

    // The learning pass reviewed the closed run: its tokens and seconds are their own line in the
    // run's cost (and in the total), and in the anonymised index.
    const costed = JSON.parse((await h.store.get(keys.runCost(owner, runId)))!.body);
    expect(costed.learner).toMatchObject({
      modelId: learningConfig.learnerModelId,
      calls: 1,
      inputTokens: 5000,
      outputTokens: 200,
    });
    expect(costed.learner.usd).toBeCloseTo(0.03, 5);
    expect(costed.totalUsd).toBeGreaterThanOrEqual(costed.learner.usd);
    expect(JSON.parse((await h.store.get(indexKey))!.body).learner).toMatchObject({
      modelId: learningConfig.learnerModelId,
      usd: costed.learner.usd,
    });
    // Nothing of the customer's run is in the global layer.
    const layer = (await h.store.list("learning/")).join("\n");
    expect(layer).toContain("learning/test/versions/1.json");
    for (const key of await h.store.list("learning/")) {
      const body = (await h.store.get(key))!.body;
      expect(body).not.toContain(runId);
      expect(body).not.toContain("127.0.0.1");
      for (const user of USERS) expect(body).not.toContain(user.password);
    }

    // No login password is anywhere in what the customer can download.
    const html = (await h.store.get(keys.runReportHtml(owner, runId)))!.body;
    const pdf = (await h.store.getBytes(keys.runReportPdf(owner, runId)))!;
    expect(pdf).toBeDefined();
    expect(Buffer.from(pdf).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    for (const user of USERS) {
      expect(JSON.stringify(report)).not.toContain(user.password);
      expect(html).not.toContain(user.password);
    }
    expect(html).toContain("6. Technical findings");

    // The three formats are offered through time-limited links; a format that does not exist is refused.
    for (const format of ["html", "pdf", "json"]) {
      const link = await browser.request("GET", `/api/runs/${runId}/report/link?format=${format}`);
      expect(link.status, format).toBe(200);
      expect(((await link.json()) as { url: string }).url).toContain(
        `swarm-report-${runId}.${format}`,
      );
    }
    expect(
      (await browser.request("GET", `/api/runs/${runId}/report/link?format=docx`)).status,
    ).toBe(400);

    // A Siege costs more than a Scout would, within its cap (the scripted model is nearly free here).
    const cost = JSON.parse((await h.store.get(keys.runCost(owner, runId)))!.body);
    expect(cost.totalUsd).toBeLessThan(limitsFor("siege").spendCapUsd);
  });
});
