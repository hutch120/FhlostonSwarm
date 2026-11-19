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

  it("Probe runs exactly its agent group, signs in once and understands the application", async () => {
    const { result, events } = await runTier("probe");
    expect([...result.agentsRun].sort()).toEqual([...tiers.probe.agents].sort());

    // Probe is planned and verified (it is a deep depth), so findings are scored by recall rather
    // than matched one for one against the seeded ground truth (see deep.test.ts for Siege).
    const want = wanted("probe", true);
    const isWanted = (f: { agent: string; title: string }) =>
      want.some((w) => w.agent === f.agent && f.title.includes(w.titleIncludes));
    const matched = want.filter((w) =>
      result.findings.some((f) => f.agent === w.agent && f.title.includes(w.titleIncludes)),
    );
    expect(matched.length / want.length).toBeGreaterThanOrEqual(0.9);
    expect(result.findings.filter((f) => !isWanted(f)).length).toBeLessThanOrEqual(1);
    void events;

    expect(result.explorerLog!.signIns).toEqual([{ slot: "admin", ok: true }]);
    const profile = result.profile!;
    expect(profile.coverage).toMatchObject({ signedIn: true, loginsUsed: 1 });
    // Profile area names are not asserted here: with Probe's larger agent group, deterministic
    // agents (authz, session, …) reach signed-in pages directly, so the LLM-driven explorer alone
    // may not narrate every one of them into its own profile (recall/precision is covered for the
    // deepest depth in deep.test.ts).
  });

  it("emits events that validate against the shared schema and fold into a sound run state", async () => {
    const { result, events } = await runTier("probe");
    for (const event of events) expect(runEventSchema.safeParse(event).success).toBe(true);
    const { agents, areas } = tierRoster("probe");
    const state = applyEvents(
      createRunState({ runId: "run_test0001", tier: "probe", areas, agents }),
      events,
    );
    for (const id of tiers.probe.agents) {
      expect(state.agents[id], id).toMatchObject({ status: "done", progress: 1 });
    }
    // Probe is a deep depth: every finding is independently re-tested, not left unverified.
    expect(result.verification).toMatchObject({ notChecked: 0 });
  });

  it("goes through the proxy only, and logs every request", async () => {
    const { stats, log, result, input } = await runTier("probe");
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
      input: inputFor(fixture.port(), "scout"),
      sink,
      dns: fakeDns,
    });
    expect(result.findings.filter((f) => f.agent !== "dns")).toHaveLength(0);
    expect(sink.events.filter((e) => e.type === "gap").length).toBeGreaterThan(3);
  });

  it("turns an exhausted request budget into gaps instead of stopping silently", async () => {
    const sink = new MemorySink();
    const { result, stats } = await runLocal({
      input: inputFor(fixture.port(), "probe", { budgets: { maxRequests: 4 } }),
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
      input: inputFor(fixture.port(), "probe", { budgets: { maxSteps: 3 } }),
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
      input: inputFor(fixture.port(), "probe"),
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

  it("covers every agent of Scout and Probe", () => {
    for (const tier of ["scout", "probe"] as const) {
      for (const id of tiers[tier].agents) expect(MODULES[id], id).toBeDefined();
    }
  });
});
