import { describe, expect, it } from "vitest";
import {
  AGENTS,
  AREAS,
  agentSpecSchema,
  areaSpecSchema,
  findingSchema,
  replayEvents,
  runEventSchema,
  summarySchema,
  tierConfigSchema,
  tiers,
  tiersConfigSchema,
  type RunEvent,
} from "./index.js";

type FinishEvent = Extract<RunEvent, { type: "finish" }>;
const findingFinish = replayEvents.find(
  (e): e is FinishEvent => e.type === "finish" && e.payload.outcome === "finding",
)!;
const startEvent = replayEvents.find((e) => e.type === "start")!;
const completeEvent = replayEvents.at(-1) as Extract<RunEvent, { type: "complete" }>;

describe("event schema", () => {
  it("validates every fixture event", () => {
    expect(replayEvents.length).toBeGreaterThan(100);
    for (const event of replayEvents) {
      const result = runEventSchema.safeParse(event);
      expect(result.success, `seq ${event.seq}`).toBe(true);
    }
  });

  it("covers every event type and outcome", () => {
    const types = new Set(replayEvents.map((e) => e.type));
    expect([...types].sort()).toEqual(
      ["agent-done", "complete", "dispatch", "finish", "gap", "start", "steer", "verify"].sort(),
    );
    const outcomes = new Set(
      replayEvents.flatMap((e) => (e.type === "finish" ? [e.payload.outcome] : [])),
    );
    expect([...outcomes].sort()).toEqual(["clear", "finding", "gap", "info"]);
  });

  it("has strictly increasing seq starting at 1 and non-decreasing timestamps", () => {
    replayEvents.forEach((e, i) => expect(e.seq).toBe(i + 1));
    for (let i = 1; i < replayEvents.length; i++) {
      expect(Date.parse(replayEvents[i]!.ts)).toBeGreaterThanOrEqual(
        Date.parse(replayEvents[i - 1]!.ts),
      );
    }
    expect(completeEvent.type).toBe("complete");
  });

  it.each<[string, unknown]>([
    ["unknown type", { ...startEvent, type: "explode" }],
    ["seq 0", { ...startEvent, seq: 0 }],
    ["fractional seq", { ...startEvent, seq: 1.5 }],
    ["missing runId", { ...startEvent, runId: undefined }],
    ["bad timestamp", { ...startEvent, ts: "yesterday" }],
    ["bad agent id", { ...startEvent, agent: "Not An Agent!" }],
    ["start without a step", { ...startEvent, payload: {} }],
    ["complete with an agent", { ...completeEvent, agent: "dns" }],
    [
      "finish with an unknown outcome",
      { ...findingFinish, payload: { ...findingFinish.payload, outcome: "maybe" } },
    ],
    [
      "finding outcome without a finding",
      {
        ...findingFinish,
        payload: { outcome: "finding", stepId: "s", label: "l", requests: 1, spendUsd: 0 },
      },
    ],
    ["negative spend", { ...findingFinish, payload: { ...findingFinish.payload, spendUsd: -1 } }],
    [
      "verify without a verdict",
      {
        type: "verify",
        seq: 1,
        ts: startEvent.ts,
        runId: startEvent.runId,
        agent: "dns",
        payload: { findingId: "F-01", note: "x" },
      },
    ],
  ])("rejects %s", (_name, bad) => {
    expect(runEventSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects malformed findings and summaries", () => {
    if (findingFinish.payload.outcome !== "finding") throw new Error("unreachable");
    const { finding } = findingFinish.payload;
    expect(findingSchema.safeParse(finding).success).toBe(true);
    expect(findingSchema.safeParse({ ...finding, severity: "catastrophic" }).success).toBe(false);
    expect(findingSchema.safeParse({ ...finding, id: "finding-1" }).success).toBe(false);
    expect(summarySchema.safeParse(completeEvent.payload.summary).success).toBe(true);
    const partial = {
      ...completeEvent.payload.summary,
      findings: { total: 1, verified: 0, bySeverity: { high: 1 } },
    };
    expect(summarySchema.safeParse(partial).success).toBe(false);
  });
});

describe("roster", () => {
  it("has 5 areas and 12 agents, each agent in a known area", () => {
    expect(AREAS).toHaveLength(5);
    expect(AGENTS).toHaveLength(12);
    const areaIds = new Set(AREAS.map((a) => a.id));
    for (const agent of AGENTS) expect(areaIds.has(agent.area)).toBe(true);
    expect(new Set(AGENTS.map((a) => a.id)).size).toBe(12);
    for (const a of AREAS) expect(areaSpecSchema.safeParse(a).success).toBe(true);
    for (const a of AGENTS) expect(agentSpecSchema.safeParse(a).success).toBe(true);
  });

  it("matches the agent grouping from the plan", () => {
    const ids = (area: string) => AGENTS.filter((a) => a.area === area).map((a) => a.id);
    expect(ids("recon")).toEqual(["dns", "surface", "bundle"]);
    expect(ids("unauth")).toEqual(["tls", "zap", "cors"]);
    expect(ids("authn")).toEqual(["authn", "session", "authz"]);
    expect(ids("llm")).toEqual(["prompt", "output"]);
    expect(ids("logic")).toEqual(["idor"]);
  });
});

describe("tier config", () => {
  it("parses the shipped config", () => {
    expect(tiers.lite.spendCapUsd).toBe(0.5);
    expect(tiers.lite.teaserFindings).toBe(2);
    expect(tiers.lite.steering).toBe(false);
    expect(tiers.full.logins).toBe(4);
    expect(tiers.full.areas).toHaveLength(5);
  });

  it("rejects invalid tiers", () => {
    expect(tierConfigSchema.safeParse({ ...tiers.lite, logins: 9 }).success).toBe(false);
    expect(tierConfigSchema.safeParse({ ...tiers.lite, spendCapUsd: 0 }).success).toBe(false);
    expect(tiersConfigSchema.safeParse({ lite: tiers.full, full: tiers.full }).success).toBe(false);
    expect(tiersConfigSchema.safeParse({ lite: tiers.lite }).success).toBe(false);
  });
});
