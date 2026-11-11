import {
  applyEvents,
  createRunState,
  tierRoster,
  tiers,
  type Finding,
  type TierId,
} from "@swarm/shared";
import { engagementSchema, GUARDRAIL_IDS } from "@swarm/shared/server";
import expected from "@swarm/synthetic-target/expected.json" with { type: "json" };
import { describe, expect, it, vi } from "vitest";
import { MemorySink } from "./emitter.js";
import { createOfflineLlm } from "./llm/offline.js";
import { runLocal } from "./local.js";
import { browserAvailable, fakeDns, inputFor, launch, stamped, useTarget } from "./testkit.js";

// Every browser run launches Chromium, and a deep run signs in several times.
vi.setConfig({ testTimeout: 120_000 });

const withAssistant = useTarget();
const withoutAssistant = useTarget({ assistant: false });

type Slots = ("admin" | "user1" | "user2")[];

async function runDeep(tier: TierId, slots: Slots, port: number) {
  const sink = new MemorySink();
  const input = inputFor(port, tier, { slots });
  const run = await runLocal({
    input,
    sink,
    allowPrivate: true,
    llm: createOfflineLlm(),
    driverFactory: launch,
    dns: fakeDns,
  });
  const events = stamped(sink);
  const { agents, areas } = tierRoster(tier);
  const state = applyEvents(createRunState({ runId: "run_test0001", tier, areas, agents }), events);
  return { ...run, sink, events, state, input };
}

/** The seeded ground truth that a depth with this many logins can reach. */
const wanted = (tier: TierId, logins: number) =>
  expected.findings.filter((f) => {
    const needs = "minLogins" in f ? f.minLogins : "needsLogin" in f && f.needsLogin ? 1 : 0;
    return tiers[tier].agents.includes(f.agent) && logins >= (needs ?? 0);
  });

/** Recall and precision against the seeded ground truth. */
function score(found: readonly Finding[], want: ReturnType<typeof wanted>) {
  const isWanted = (f: Finding) =>
    want.some((w) => w.agent === f.agent && f.title.includes(w.titleIncludes));
  const matched = want.filter((w) =>
    found.some((f) => f.agent === w.agent && f.title.includes(w.titleIncludes)),
  );
  return {
    recall: matched.length / want.length,
    stray: found.filter((f) => !isWanted(f)),
    unverifiedExpected: found.filter((f) => isWanted(f) && !f.verified),
  };
}

const agentFindings = (state: { findings: Finding[] }, agent: string) =>
  state.findings.filter((f) => f.agent === agent);

describe.skipIf(!browserAvailable)("deep scans against the synthetic target", () => {
  it("Siege meets the recall and precision bar on the seeded ground truth, every finding verified", async () => {
    const { result, state, events, input } = await runDeep(
      "siege",
      ["admin", "user1", "user2"],
      withAssistant.port(),
    );
    expect([...result.agentsRun].sort()).toEqual([...tiers.siege.agents].sort());

    const want = wanted("siege", 3);
    const s = score(state.findings, want);
    // The bar: at least 80% of the seeded issues found, at most one stray (unexpected) finding.
    expect(s.recall).toBeGreaterThanOrEqual(0.8);
    expect(s.stray.length).toBeLessThanOrEqual(1);
    expect(s.unverifiedExpected).toEqual([]);

    // The seeded IDOR, the admin-only page reachable by user1, the verbose error, the CORS issue
    // and the LLM-style injection endpoint are all among them.
    const titles = state.findings.map((f) => `${f.agent}: ${f.title}`).join("\n");
    for (const phrase of [
      "idor: Users can read other users' records",
      "authz: Pages meant for administrators are open to a lower role",
      "zap: Error pages reveal internal details",
      "cors: CORS reflects any Origin",
      "prompt: AI feature follows instructions injected",
    ]) {
      expect(titles).toContain(phrase);
    }

    // Every candidate was independently re-tested, by the verifier, once.
    const verdicts = events.flatMap((e) => (e.type === "verify" ? [e] : []));
    expect(verdicts).toHaveLength(state.findings.length);
    expect(new Set(verdicts.map((v) => v.agent))).toEqual(new Set(["verifier"]));
    expect(result.verification).toMatchObject({ unconfirmed: 0, notChecked: 0 });

    // The plan names every agent, keeps every guardrail and was produced from discovery.
    const plan = engagementSchema.parse(result.engagement);
    expect(plan.agents.map((a) => a.id)).toEqual(tiers.siege.agents);
    expect(plan.guardrails).toEqual(GUARDRAIL_IDS);
    expect(plan.scope.hosts).toEqual(["127.0.0.1"]);
    expect(plan.roles.map((r) => r.slot)).toEqual(["admin", "user1", "user2"]);
    expect(plan.hints.ai.map((a) => a.path)).toEqual(
      expect.arrayContaining(["/assistant", "/api/assistant"]),
    );
    expect(plan.instructionsVersion).toMatch(/^\d{4}\.\d+\.\d+$/);

    // No password reaches an event.
    const wire = JSON.stringify(events);
    for (const login of Object.values(input.logins)) expect(wire).not.toContain(login.password);
  });

  it("Probe runs its own group on two logins and finds the subset its agents cover", async () => {
    const { result, state } = await runDeep("probe", ["admin", "user1"], withAssistant.port());
    expect([...result.agentsRun].sort()).toEqual([...tiers.probe.agents].sort());
    const want = wanted("probe", 2);
    expect(want.some((w) => w.agent === "idor")).toBe(false);
    const s = score(state.findings, want);
    expect(s.recall).toBeGreaterThanOrEqual(0.8);
    expect(s.stray.length).toBeLessThanOrEqual(1);
    expect(s.unverifiedExpected).toEqual([]);
    // Siege-only work is not done at Probe depth.
    expect(agentFindings(state, "idor")).toEqual([]);
    expect(state.findings.every((f) => f.verified)).toBe(true);
  });

  it("plans Phase 4 as not applicable for an application with no AI feature", async () => {
    const { result, state, events } = await runDeep(
      "probe",
      ["admin", "user1"],
      withoutAssistant.port(),
    );
    const plan = engagementSchema.parse(result.engagement);
    expect(plan.agents.filter((a) => !a.enabled).map((a) => a.id)).toEqual(["prompt", "output"]);
    for (const id of ["prompt", "output"]) {
      expect(state.agents[id]).toMatchObject({ status: "done", progress: 1 });
      expect(state.agents[id]!.doneSummary).toMatch(/^Not applicable: No AI/);
      expect(state.agents[id]!.history).toEqual([]);
      expect(agentFindings(state, id)).toEqual([]);
    }
    // It did not run the AI checks, and the other phases still found what they cover.
    expect(
      events.some((e) => e.type === "start" && (e.agent === "prompt" || e.agent === "output")),
    ).toBe(false);
    expect(state.findings.some((f) => f.agent === "authz")).toBe(true);
  });

  it("stays read-only: nothing but the sign-ins ever changes state", async () => {
    await runDeep("siege", ["admin", "user1", "user2"], withAssistant.port());
    const writes = withAssistant
      .target()
      .seen.filter((r) => !["GET", "HEAD", "OPTIONS"].includes(r.method));
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((r) => r.method === "POST" && r.path === "/api/login")).toBe(true);
    // The hostile page's delete requests never arrived.
    expect(withAssistant.target().seen.some((r) => /danger|delete-all/.test(r.path))).toBe(false);
  });

  it("explores each role's pages, so the object checks know who owns what", async () => {
    const { result } = await runDeep("siege", ["admin", "user1", "user2"], withAssistant.port());
    expect(result.explorerLog!.signIns).toEqual([
      { slot: "admin", ok: true },
      { slot: "user1", ok: true },
      { slot: "user2", ok: true },
    ]);
    // The signed-in pages of each login were mapped (the model did not have to find them).
    expect(result.explorerLog!.pages).toEqual(
      expect.arrayContaining(["/orders", "/profile", "/orders/101", "/orders/201"]),
    );
  });
});
