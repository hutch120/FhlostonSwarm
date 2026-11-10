import {
  AGENTS,
  applyEvents,
  createRunState,
  runEventSchema,
  tierRoster,
  tiers,
} from "@swarm/shared";
import type { TierId } from "@swarm/shared";
import expected from "@swarm/synthetic-target/expected.json" with { type: "json" };
import { describe, expect, it, vi } from "vitest";
import { MemorySink } from "./emitter.js";
import { createOfflineLlm } from "./llm/offline.js";
import { runLocal } from "./local.js";
import { MODULES } from "./runner.js";
import { browserAvailable, fakeDns, inputFor, launch, stamped, useTarget } from "./testkit.js";

// Every browser run launches Chromium.
vi.setConfig({ testTimeout: 60_000 });

const fixture = useTarget();

const wanted = (tier: TierId, login: boolean) =>
  expected.findings.filter(
    (f) => tiers[tier].agents.includes(f.agent) && (login || !("needsLogin" in f && f.needsLogin)),
  );

async function runTier(tier: TierId, options: { login?: boolean } = {}) {
  const sink = new MemorySink();
  const input = inputFor(fixture.port(), tier, { logins: options.login });
  const run = await runLocal({
    input,
    sink,
    allowPrivate: true,
    llm: createOfflineLlm(),
    driverFactory: launch,
    dns: fakeDns,
  });
  return { ...run, sink, events: stamped(sink), input };
}

describe.skipIf(!browserAvailable)("shallow scans against the synthetic target", () => {
  it("Scout runs exactly its agent group and raises only unauthenticated findings", async () => {
    const { result, events } = await runTier("scout");
    expect([...result.agentsRun].sort()).toEqual([...tiers.scout.agents].sort());

    const raised = events.flatMap((e) =>
      e.type === "finish" && e.payload.outcome === "finding"
        ? [{ agent: e.agent, step: e.payload.stepId, finding: e.payload.finding }]
        : [],
    );
    const want = wanted("scout", false);
    expect(raised).toHaveLength(want.length);
    for (const w of want) {
      const got = raised.find((r) => r.agent === w.agent && r.step === w.step);
      expect(got, `${w.agent}.${w.step}`).toBeDefined();
      expect(got!.finding.severity).toBe(w.severity);
      expect(got!.finding.title).toContain(w.titleIncludes);
    }
    // No login, so nothing signed in and nothing beyond the public pages.
    expect(result.explorerLog!.signIns).toEqual([]);
    expect(result.profile).not.toBeNull();
    expect(result.profile!.coverage.signedIn).toBe(false);
    expect(result.profile!.areas.every((a) => !a.requiresLogin)).toBe(true);
  });

  it("Sweep runs exactly its agent group, signs in once and understands the application", async () => {
    const { result, events } = await runTier("sweep");
    expect([...result.agentsRun].sort()).toEqual([...tiers.sweep.agents].sort());

    const raised = events.flatMap((e) =>
      e.type === "finish" && e.payload.outcome === "finding"
        ? [{ agent: e.agent, step: e.payload.stepId, finding: e.payload.finding }]
        : [],
    );
    const want = wanted("sweep", true);
    expect(raised).toHaveLength(want.length);
    for (const w of want) {
      const got = raised.find((r) => r.agent === w.agent && r.step === w.step);
      expect(got, `${w.agent}.${w.step}`).toBeDefined();
      expect(got!.finding.severity).toBe(w.severity);
      expect(got!.finding.title).toContain(w.titleIncludes);
    }

    expect(result.explorerLog!.signIns).toEqual([{ slot: "admin", ok: true }]);
    const profile = result.profile!;
    expect(profile.coverage).toMatchObject({ signedIn: true, loginsUsed: 1 });
    const names = profile.areas.map((a) => a.name.toLowerCase());
    for (const area of [...expected.app.publicAreas, ...expected.app.signedInAreas]) {
      expect(
        names.some((n) => n.includes(area)),
        area,
      ).toBe(true);
    }
    // The administrator's area is only reachable signed in, and the profile says so.
    const admin = profile.areas.find((a) => /manage users|users/i.test(a.name));
    expect(admin?.requiresLogin).toBe(true);
  });

  it("emits events that validate against the shared schema and fold into a sound run state", async () => {
    const { events } = await runTier("sweep");
    for (const event of events) expect(runEventSchema.safeParse(event).success).toBe(true);
    const { agents, areas } = tierRoster("sweep");
    const state = applyEvents(
      createRunState({ runId: "run_test0001", tier: "sweep", areas, agents }),
      events,
    );
    for (const id of tiers.sweep.agents) {
      expect(state.agents[id], id).toMatchObject({ status: "done", progress: 1 });
    }
    expect(state.findings.every((f) => f.verified === false)).toBe(true);
  });

  it("goes through the proxy only, and logs every request", async () => {
    const { stats, log, result, input } = await runTier("sweep");
    expect(stats.requests).toBeGreaterThan(10);
    expect(log.entries.every((e) => e.host === "127.0.0.1" && e.decision !== undefined)).toBe(true);
    // The browser's requests and the agents' requests together stay inside the run's request cap.
    expect(stats.requests).toBeLessThanOrEqual(input.budgets.maxRequests);
    // Exactly one sign-in submission was allowed through (the proxy logs it as such).
    const logins = log.entries.filter((e) => e.reason === "login_submission");
    expect(logins).toHaveLength(1);
    expect(logins[0]).toMatchObject({ method: "POST", path: "/api/login", decision: "allowed" });
    expect(result.explorerLog!.pages.length).toBeGreaterThan(3);
  });
});

describe("agents without a model or browser", () => {
  it("report the explorer-driven steps as gaps and still run the deterministic checks", async () => {
    const sink = new MemorySink();
    const { result } = await runLocal({
      input: inputFor(fixture.port(), "scout"),
      sink,
      allowPrivate: true,
      dns: fakeDns,
    });
    expect(result.profile).toBeNull();
    const titles = result.findings.map((f) => f.title);
    expect(titles.some((t) => t.includes("plain HTTP"))).toBe(true);
    expect(titles.some((t) => t.includes("Source maps"))).toBe(false); // bundle is not in Scout
    const gaps = sink.events.filter((e) => e.type === "gap");
    expect(gaps.some((g) => g.type === "gap" && /explorer/i.test(g.payload.reason))).toBe(true);
  });

  it("is refused when the proxy would reach a private address (no allowPrivate)", async () => {
    const sink = new MemorySink();
    const { result } = await runLocal({
      input: inputFor(fixture.port(), "sweep"),
      sink,
      dns: fakeDns,
    });
    expect(result.findings.filter((f) => f.agent !== "dns")).toHaveLength(0);
    expect(sink.events.filter((e) => e.type === "gap").length).toBeGreaterThan(3);
  });

  it("turns an exhausted request budget into gaps instead of stopping silently", async () => {
    const sink = new MemorySink();
    const { result, stats } = await runLocal({
      input: inputFor(fixture.port(), "sweep", { budgets: { maxRequests: 4 } }),
      sink,
      allowPrivate: true,
      dns: fakeDns,
    });
    expect(result.stoppedBy).toBe("requests");
    expect(stats.requests).toBeLessThanOrEqual(4);
    const gaps = sink.events.filter((e) => e.type === "gap");
    expect(gaps.some((g) => g.type === "gap" && /request budget/i.test(g.payload.reason))).toBe(
      true,
    );
  });

  it("stops at the step budget", async () => {
    const sink = new MemorySink();
    const { result } = await runLocal({
      input: inputFor(fixture.port(), "sweep", { budgets: { maxSteps: 3 } }),
      sink,
      allowPrivate: true,
      dns: fakeDns,
    });
    expect(result.stoppedBy).toBe("steps");
    expect(result.checks).toBeLessThanOrEqual(3);
  });

  it("stops when told to (SIGTERM)", async () => {
    const sink = new MemorySink();
    let calls = 0;
    const { result } = await runLocal({
      input: inputFor(fixture.port(), "sweep"),
      sink,
      allowPrivate: true,
      dns: fakeDns,
      aborted: () => ++calls > 2,
    });
    expect(result.stoppedBy).toBe("aborted");
  });
});

describe("roster coverage", () => {
  it("implements every roster step of the agents it provides", () => {
    for (const [id, module] of Object.entries(MODULES)) {
      const spec = AGENTS.find((a) => a.id === id)!;
      expect(Object.keys(module.steps).sort()).toEqual(spec.steps.map((s) => s.id).sort());
    }
  });

  it("covers every agent of Scout and Sweep", () => {
    for (const tier of ["scout", "sweep"] as const) {
      for (const id of tiers[tier].agents) expect(MODULES[id], id).toBeDefined();
    }
  });
});
