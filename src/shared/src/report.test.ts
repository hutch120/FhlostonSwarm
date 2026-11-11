import { describe, expect, it } from "vitest";
import {
  AGENTS,
  AREAS,
  DEMO_RUN_ID,
  REPORT_DISCLAIMER,
  applyEvents,
  buildReport,
  createRunState,
  replayEvents,
  runReportSchema,
  summarise,
  tierRoster,
  type Finding,
  type RunEvent,
  type TierId,
} from "./index.js";
import { GUARDRAIL_IDS, INSTRUCTIONS_VERSION, type Engagement } from "./engagement.js";

const SECRETS = {
  password: "hunter2-secret-pw",
  cookie: "0f3a9c1b7d5e",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  aws: "AKIAIOSFODNN7EXAMPLE",
};

const base = (tier: TierId = "siege") => {
  const { agents, areas } = tierRoster(tier);
  const state = applyEvents(
    createRunState({ runId: DEMO_RUN_ID, tier, areas, agents }),
    replayEvents,
  );
  return { state, summary: summarise(state) };
};

const report = (extra: Partial<Parameters<typeof buildReport>[0]> = {}) => {
  const { state, summary } = base();
  return buildReport({
    state,
    events: replayEvents,
    summary,
    target: "portal.example",
    generatedAt: replayEvents.at(-1)!.ts,
    ...extra,
  });
};

const engagement = (overrides: Partial<Engagement> = {}): Engagement => ({
  version: 1,
  runId: DEMO_RUN_ID,
  tier: "siege",
  instructionsVersion: INSTRUCTIONS_VERSION,
  guardrails: [...GUARDRAIL_IDS],
  scope: { hosts: ["portal.example"], readOnly: true },
  agents: tierRoster("siege").agents.map((a) => ({ id: a.id, enabled: true })),
  skippedChecks: [],
  roles: [{ slot: "admin", description: "Administrator", kind: "admin" }],
  matrix: [],
  hints: { routes: [], apiBases: [], ai: [] },
  budget: { wallClockSeconds: 3600, maxSteps: 400, maxRequests: 3000, spendCapUsd: 15 },
  plannedBy: "rules",
  notes: [],
  ...overrides,
});

describe("the report data", () => {
  it("is valid, complete and computed from the events", () => {
    const r = report();
    expect(runReportSchema.safeParse(r).success).toBe(true);
    const { summary } = base();
    expect(r.counts.total).toBe(summary.findings.total);
    expect(r.counts.verified).toBe(summary.findings.verified);
    expect(r.counts.bySeverity).toEqual(summary.findings.bySeverity);
    expect(r.counts.unconfirmed).toBe(r.findings.filter((f) => f.status === "unconfirmed").length);
    expect(r.disclaimer).toBe(REPORT_DISCLAIMER);
    expect(r.instructionsVersion).toBe(INSTRUCTIONS_VERSION);
  });

  it("carries no cost field a customer must not see", () => {
    const text = JSON.stringify(report(), (_key, value) => value);
    expect(Object.keys(JSON.parse(text) as object).join(" ")).not.toMatch(/spend|usd|cost|budget/i);
    expect(text).not.toMatch(/"spendCapUsd"|"budget"/);
  });

  it("lists every check of the depth by phase, with how each ended", () => {
    const r = report();
    expect(r.phases.map((p) => p.phase)).toEqual(AREAS.map((a) => a.phase));
    const checks = r.phases.flatMap((p) => p.checks);
    expect(checks).toHaveLength(AGENTS.flatMap((a) => a.steps).length);
    expect(checks.find((c) => c.agent === "tls" && c.stepId === "protocols")).toMatchObject({
      outcome: expect.stringMatching(/clear|finding|info|gap/),
    });
    // A step that finds something points at its finding.
    const found = checks.filter((c) => c.outcome === "finding");
    expect(found.length).toBe(r.findings.length);
    for (const c of found) expect(r.findings.some((f) => f.id === c.detail)).toBe(true);
  });

  it("shows the verification verdict per finding, and unconfirmed ones last among equals", () => {
    const r = report();
    const verified = r.findings.find((f) => f.verified)!;
    expect(verified.verification.checked).toBe(true);
    const unconfirmed = r.findings.filter((f) => f.status === "unconfirmed");
    expect(unconfirmed.length).toBeGreaterThan(0);
    for (const f of unconfirmed) expect(f.verification.checked).toBe(true);
    const ranks = r.priorities.map((p) => p.rank);
    expect(ranks).toEqual(ranks.map((_, i) => i + 1));
    for (let i = 1; i < r.priorities.length; i += 1) {
      const a = r.priorities[i - 1]!;
      const b = r.priorities[i]!;
      const order = ["info", "low", "medium", "high", "critical"];
      expect(order.indexOf(a.severity)).toBeGreaterThanOrEqual(order.indexOf(b.severity));
      if (a.severity === b.severity)
        expect(Number(a.confirmed)).toBeGreaterThanOrEqual(Number(b.confirmed));
    }
  });

  it("says so when a depth never cross-checks", () => {
    const { state, summary } = base("sweep");
    const events = replayEvents.filter((e) => e.type !== "verify");
    const stripped = applyEvents(
      createRunState({ runId: DEMO_RUN_ID, tier: "sweep", ...tierRoster("sweep") }),
      events,
    );
    const r = buildReport({
      state: stripped,
      events,
      summary,
      target: "t.example",
      generatedAt: "2026-11-10T00:00:00.000Z",
    });
    void state;
    expect(r.findings.every((f) => !f.verification.checked)).toBe(true);
    expect(r.ai.status).toBe("not-included");
    expect(r.phases.flatMap((p) => p.checks).some((c) => c.agent === "prompt")).toBe(false);
  });
});

describe("the AI/LLM section", () => {
  it("is tested when the depth has the agents and the plan keeps them", () => {
    const r = report({ engagement: engagement() });
    expect(r.ai.status).toBe("tested");
  });

  it("is not applicable when the plan found no AI feature, and the checks say why", () => {
    const reason = "No AI or language-model feature was found on the pages explored.";
    const r = report({
      engagement: engagement({
        agents: tierRoster("siege").agents.map((a) => ({
          id: a.id,
          enabled: !["prompt", "output"].includes(a.id),
          ...(["prompt", "output"].includes(a.id) ? { reason } : {}),
        })),
      }),
    });
    expect(r.ai).toMatchObject({ status: "not-applicable", findings: [] });
    expect(r.ai.summary).toContain(reason);
    expect(r.plan!.notApplicable.map((n) => n.agent)).toEqual(["prompt", "output"]);
    const llmChecks = r.phases.find((p) => p.area === "llm")!.checks;
    // Steps that never ran are reported as not applicable here only when the plan said so.
    for (const c of llmChecks.filter((x) => x.outcome === "not-applicable")) {
      expect(c.detail).toBe(reason);
    }
  });

  it("is not included at the depths without the AI agents", () => {
    const { state, summary } = base("sweep");
    const events: RunEvent[] = [];
    const r = buildReport({
      state: { ...state, tier: "sweep" },
      events,
      summary,
      target: "t.example",
      generatedAt: "2026-11-10T00:00:00.000Z",
    });
    expect(r.ai.status).toBe("not-included");
  });
});

describe("the redaction pass", () => {
  /** A report whose every free-text field carries planted secrets. */
  function plantedReport() {
    const { state, summary } = base();
    const poison = (s: string) =>
      `${s} password=${SECRETS.password} Cookie: sid=${SECRETS.cookie}; Authorization: Bearer ${SECRETS.jwt} key ${SECRETS.aws} and plain ${SECRETS.password} owner admin@example.com`;
    const findings: Finding[] = state.findings.map((f) => ({
      ...f,
      description: poison(f.description),
      remediation: poison(f.remediation),
      title: poison(f.title),
      component: poison(f.component),
      evidence: [poison("evidence")],
      reproduction: [poison("step")],
    }));
    const events = replayEvents.map((e): RunEvent => {
      if (e.type === "finish" && e.payload.outcome === "info") {
        return { ...e, payload: { ...e.payload, note: poison(e.payload.note) } };
      }
      if (e.type === "gap")
        return { ...e, payload: { ...e.payload, reason: poison(e.payload.reason) } };
      if (e.type === "verify")
        return { ...e, payload: { ...e.payload, note: poison(e.payload.note) } };
      return e;
    });
    const poisoned = applyEvents(
      createRunState({ runId: DEMO_RUN_ID, tier: "siege", ...tierRoster("siege") }),
      events,
    );
    return buildReport({
      state: { ...poisoned, findings },
      events,
      summary,
      target: "portal.example",
      generatedAt: replayEvents.at(-1)!.ts,
      profile: {
        purpose: poison("An app."),
        areas: [],
        roles: [],
        flows: [],
        technologies: [],
        coverage: { pagesVisited: 1, loginsUsed: 0, signedIn: false },
      },
      engagement: engagement({ notes: [poison("note")] }),
      redact: { secrets: [SECRETS.password, SECRETS.cookie] },
    });
  }

  it("removes planted passwords, tokens, cookies and keys from the data", () => {
    const text = JSON.stringify(plantedReport());
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(text, name).not.toContain(secret);
    }
    expect(text).toContain("[redacted]");
  });

  it("masks personal addresses in evidence", () => {
    const r = plantedReport();
    expect(
      r.findings.every((f) => f.evidence?.every((e) => !e.includes("admin@example.com"))),
    ).toBe(true);
  });
});
