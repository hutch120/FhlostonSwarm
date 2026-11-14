import { describe, expect, it } from "vitest";
import {
  AGENTS,
  AREAS,
  DEMO_RUN_ID,
  applyEvent,
  applyEvents,
  createRunState,
  replayEvents,
  selectAreas,
  summarise,
  summarySchema,
  type RunEvent,
} from "./index.js";

const fresh = () =>
  createRunState({ runId: DEMO_RUN_ID, tier: "siege", areas: AREAS, agents: AGENTS });
const finalState = () => applyEvents(fresh(), replayEvents);

describe("applyEvent over the scripted run", () => {
  it("adds a dynamic agent to the swarm when its first dispatch carries its spec, and only then", () => {
    const spec = {
      id: "dyn-debug-vars",
      name: "Debug variables",
      area: "unauth" as const,
      colour: "#a3e635",
      face: "hex" as const,
      steps: [{ id: "vars", label: "Runtime variables endpoint" }],
    };
    const base = createRunState({
      runId: DEMO_RUN_ID,
      tier: "probe",
      areas: AREAS.filter((a) => a.id === "recon"),
      agents: AGENTS.filter((a) => a.area === "recon"),
    });
    const at = { ts: "2026-11-14T00:00:00.000Z", runId: DEMO_RUN_ID };
    const dispatch = (seq: number, payload: { task: string; spec?: typeof spec }): RunEvent => ({
      ...at,
      seq,
      type: "dispatch",
      agent: spec.id,
      payload,
    });
    // Without a spec an unknown agent is ignored, as before.
    expect(applyEvent(base, dispatch(1, { task: "Look" })).agents[spec.id]).toBeUndefined();

    let state = applyEvent(base, dispatch(1, { task: "Look", spec }));
    expect(state.agentOrder.at(-1)).toBe(spec.id);
    expect(state.agents[spec.id]).toMatchObject({ status: "dispatched", task: "Look", spec });
    // Its area joins the areas panel when the depth did not already have it.
    expect(state.areas.map((a) => a.id)).toEqual(["recon", "unauth"]);

    state = applyEvents(state, [
      {
        ...at,
        seq: 2,
        type: "start",
        agent: spec.id,
        payload: { stepId: "vars", label: spec.steps[0]!.label },
      },
      {
        ...at,
        seq: 3,
        type: "finish",
        agent: spec.id,
        payload: { outcome: "clear", stepId: "vars", label: spec.steps[0]!.label, requests: 1 },
      },
      { ...at, seq: 4, type: "agent-done", agent: spec.id, payload: { summary: "Done" } },
    ]);
    expect(state.agents[spec.id]).toMatchObject({ status: "done", progress: 1, stepsDone: 1 });
    // A second dispatch with the spec again does not add it twice.
    expect(
      applyEvent(state, dispatch(5, { task: "Again", spec })).agentOrder.filter(
        (id) => id === spec.id,
      ),
    ).toHaveLength(1);
  });

  it("reaches the expected final state", () => {
    const state = finalState();
    expect(state.status).toBe("complete");
    expect(state.lastSeq).toBe(replayEvents.length);
    expect(state.checks).toBe(41);
    expect(state.gaps).toHaveLength(3);
    expect(state.findings).toHaveLength(11);
    expect(Object.values(state.agents).every((a) => a.status === "done" && a.progress === 1)).toBe(
      true,
    );
    expect(state.summary).not.toBeNull();
  });

  it("sorts findings by severity, then id", () => {
    const { findings } = finalState();
    expect(findings.map((f) => f.id)).toEqual([
      "F-01",
      "F-02",
      "F-03",
      "F-04",
      "F-05",
      "F-06",
      "F-07",
      "F-08",
      "F-09",
      "F-10",
      "F-11",
    ]);
    expect(findings.map((f) => f.severity)).toEqual([
      "critical",
      "high",
      "high",
      "medium",
      "medium",
      "medium",
      "medium",
      "low",
      "low",
      "low",
      "info",
    ]);
  });

  it("keeps findings sorted while they arrive out of severity order", () => {
    const state = applyEvents(
      fresh(),
      replayEvents.filter((e) => e.type === "finish" && e.payload.outcome === "finding"),
    );
    const ranks = state.findings.map((f) => f.severity);
    expect(ranks[0]).toBe("critical");
    expect(ranks.at(-1)).toBe("info");
  });

  it("marks verified findings open, failed cross-checks unconfirmed and the rest unverified", () => {
    const { findings } = finalState();
    const byId = Object.fromEntries(findings.map((f) => [f.id, f]));
    expect(byId["F-01"]).toMatchObject({ verified: true, status: "open" });
    expect(byId["F-06"]).toMatchObject({ verified: false, status: "unconfirmed" });
    expect(byId["F-11"]).toMatchObject({ verified: false, status: "unverified" });
    expect(findings.filter((f) => f.verified)).toHaveLength(7);
  });

  it("counts gap steps as steps done but not as completed checks", () => {
    const state = finalState();
    expect(state.agents["authn"]).toMatchObject({ stepsDone: 4, lastOutcome: "gap" });
    expect(state.checks).toBe(41); // 43 steps, 2 of them gaps
  });

  it("matches the backend summary carried by the complete event", () => {
    const state = finalState();
    const live = summarise(state);
    expect(summarySchema.parse(state.summary)).toEqual(live);
    expect(live.findings).toEqual({
      total: 11,
      verified: 7,
      bySeverity: { critical: 1, high: 2, medium: 4, low: 3, info: 1 },
    });
    expect(live.agents).toEqual({ total: 12, done: 12 });
    expect(live.gaps).toBe(3);
  });

  it("reports full progress for every area", () => {
    const areas = selectAreas(finalState());
    expect(areas).toHaveLength(5);
    for (const area of areas) {
      expect(area.progress).toBe(1);
      expect(area.agentsDone).toBe(area.agentIds.length);
    }
    expect(areas.reduce((n, a) => n + a.findings, 0)).toBe(11);
  });

  it("is partway through at the midpoint", () => {
    const half = applyEvents(fresh(), replayEvents.slice(0, Math.floor(replayEvents.length / 2)));
    expect(half.status).toBe("running");
    expect(half.summary).toBeNull();
    const progress = selectAreas(half).map((a) => a.progress);
    expect(Math.max(...progress)).toBeGreaterThan(0);
    expect(Math.min(...progress)).toBeLessThan(1);
  });
});

describe("idempotency", () => {
  it("ignores duplicate seq", () => {
    const first = replayEvents.slice(0, 20);
    const once = applyEvents(fresh(), first);
    const twice = applyEvents(once, first);
    expect(twice).toBe(once);
    expect(applyEvents(fresh(), [...first, ...first])).toEqual(once);
  });

  it("ignores events older than the last applied seq", () => {
    const state = applyEvents(fresh(), replayEvents.slice(0, 30));
    expect(applyEvent(state, replayEvents[4]!)).toBe(state);
  });

  it("ignores events from a different run", () => {
    const state = fresh();
    const stranger = { ...replayEvents[0]!, runId: "run_other0001" } as RunEvent;
    expect(applyEvent(state, stranger)).toBe(state);
  });

  it("replaying the whole script twice gives the same final state", () => {
    const once = finalState();
    expect(applyEvents(once, replayEvents)).toBe(once);
  });

  it("does not mutate the previous state", () => {
    const before = fresh();
    const snapshot = structuredClone(before);
    applyEvents(before, replayEvents);
    expect(before).toEqual(snapshot);
  });
});
