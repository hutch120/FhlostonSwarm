import type { AddressInfo } from "node:net";
import type http from "node:http";
import { runEventsPageSchema, runReportSchema, TERMS_VERSION } from "@swarm/shared";
import expected from "@swarm/synthetic-target/expected.json" with { type: "json" };
import { createTarget, USERS } from "@swarm/synthetic-target";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getCredits, grantCredits } from "./credits.js";
import { emailHash, parseEmail } from "./identity.js";
import { LocalLauncher } from "./local-launcher.js";
import { keys } from "./storage/keys.js";
import { putJson } from "./storage/json.js";
import { createHarness, testSecrets, type Harness, type TestBrowser } from "./testkit.js";

/**
 * The whole pipeline in one process: a run started through the API is executed by the real agent
 * (behind the real scope proxy) against the synthetic target, its events go through the internal API
 * into the log and the live channel, and the run is closed with a report. Only AWS is replaced.
 */
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

describe("a run, end to end", () => {
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
    expect(run.summary.findings.total).toBe(expected.findings.length);
    // tls, zap and cors ran; dns, surface, bundle and authn are not available yet.
    expect(run.summary.agents).toEqual({ total: 7, done: 3 });
    expect(run.summary.coverage).toBeCloseTo(3 / 7, 2);

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
    for (const want of expected.findings) {
      const got = report.findings.find(
        (f) => f.agent === want.agent && f.title.includes(want.titleIncludes),
      );
      expect(got, `${want.agent}: ${want.titleIncludes}`).toBeDefined();
      expect(got!.severity).toBe(want.severity);
    }
    expect(report.gaps.map((g) => g.agent).sort()).toEqual(["authn", "bundle", "dns", "surface"]);

    // The agent's requests went through the proxy, which logged them as evidence.
    const log = JSON.parse((await h.store.get(keys.runEvidence(owner, runId, "proxy-log")))!.body);
    expect(log.entries.length).toBeGreaterThanOrEqual(8);
    expect(log.entries.every((e: { decision: string }) => e.decision === "allowed")).toBe(true);

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
    expect(new Set(report.findings.map((f) => f.agent))).toEqual(new Set(["tls", "cors"]));
    expect(report.summary.agents.total).toBe(4);
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
