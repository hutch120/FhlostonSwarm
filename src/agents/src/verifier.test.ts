import { findingSchema } from "@swarm/shared";
import { describe, expect, it } from "vitest";
import { BudgetExhausted } from "./budget.js";
import { Emitter, MemorySink } from "./emitter.js";
import { verifyCandidates, type Candidate } from "./verifier.js";
import type { AgentModule, StepContext } from "./types.js";

const finding = (n: number, agent = "zap") =>
  findingSchema.parse({
    id: `F-${String(n).padStart(2, "0")}`,
    title: `Candidate ${n}`,
    severity: "high",
    area: "unauth",
    agent,
    component: "GET /x",
    description: "d",
    remediation: "r",
    verified: false,
    status: "unverified",
  });

function harness(modules: Record<string, AgentModule> = {}, aborted?: () => boolean) {
  const sink = new MemorySink();
  const emitter = new Emitter({ runId: "run_test0001", sink });
  const verdicts: [string, boolean][] = [];
  return {
    sink,
    emitter,
    verdicts,
    deps: {
      emitter,
      verifier: "verifier",
      modules,
      freshContext: () => ({}) as StepContext,
      redact: (text: string) => text.replaceAll("hunter2-secret", "[redacted]"),
      aborted,
      onVerdict: (id: string, verified: boolean) => verdicts.push([id, verified]),
    },
  };
}

const verifyEvents = (sink: MemorySink) =>
  sink.events.flatMap((e) => (e.type === "verify" ? [e.payload] : []));

describe("the verifier stage", () => {
  it("marks a finding verified only when its re-test reproduces it", async () => {
    const h = harness();
    const candidates: Candidate[] = [
      {
        finding: finding(1),
        stepId: "headers",
        replay: async () => ({ confirmed: true, note: "Seen again." }),
      },
    ];
    const summary = await verifyCandidates(candidates, h.deps);
    await h.emitter.flush();
    expect(summary).toEqual({ confirmed: 1, unconfirmed: 0, notChecked: 0 });
    expect(verifyEvents(h.sink)).toEqual([
      { findingId: "F-01", verified: true, note: "Reproduced. Seen again." },
    ]);
  });

  it("downgrades a fabricated false positive to unconfirmed", async () => {
    const h = harness();
    // Nothing is wrong at the target: the independent re-test finds nothing.
    const fabricated: Candidate = {
      finding: finding(1),
      stepId: "x",
      replay: async () => ({ confirmed: false, note: "The page answered 404, as it should." }),
    };
    const summary = await verifyCandidates([fabricated], h.deps);
    await h.emitter.flush();
    expect(summary.unconfirmed).toBe(1);
    expect(verifyEvents(h.sink)[0]).toMatchObject({ findingId: "F-01", verified: false });
    expect(verifyEvents(h.sink)[0]!.note).toContain("Could not be reproduced");
    expect(h.verdicts).toEqual([["F-01", false]]);
  });

  it("re-runs the whole check in a fresh context when a finding has no replay of its own", async () => {
    let contexts = 0;
    const module = (outcome: "finding" | "clear"): AgentModule => ({
      id: "zap",
      task: "t",
      steps: {
        headers: async () =>
          outcome === "finding" ? ({ outcome, finding: {} } as never) : { outcome: "clear" },
      },
      doneSummary: () => "",
    });
    for (const [outcome, verified] of [
      ["finding", true],
      ["clear", false],
    ] as const) {
      const h = harness({ zap: module(outcome) });
      h.deps.freshContext = () => {
        contexts += 1;
        return {} as StepContext;
      };
      await verifyCandidates([{ finding: finding(1), stepId: "headers" }], h.deps);
      await h.emitter.flush();
      expect(verifyEvents(h.sink)[0]!.verified).toBe(verified);
    }
    expect(contexts).toBe(2);
  });

  it("is unconfirmed, never verified, when the finding cannot be re-tested independently", async () => {
    const h = harness();
    await verifyCandidates(
      [
        {
          finding: finding(1),
          stepId: "a",
          replay: async () => ({ confirmed: null, note: "No second sample." }),
        },
        { finding: finding(2, "ghost"), stepId: "missing" },
        {
          finding: finding(3),
          stepId: "b",
          replay: async () => {
            throw new Error("boom");
          },
        },
      ],
      h.deps,
    );
    await h.emitter.flush();
    expect(verifyEvents(h.sink).map((v) => v.verified)).toEqual([false, false, false]);
    expect(verifyEvents(h.sink)[0]!.note).toContain("Could not be re-tested independently");
  });

  it("stops at a run limit and leaves the rest unchecked", async () => {
    const h = harness();
    const summary = await verifyCandidates(
      [
        { finding: finding(1), stepId: "a", replay: async () => ({ confirmed: true, note: "ok" }) },
        {
          finding: finding(2),
          stepId: "a",
          replay: async () => {
            throw new BudgetExhausted("requests");
          },
        },
        { finding: finding(3), stepId: "a", replay: async () => ({ confirmed: true, note: "ok" }) },
      ],
      h.deps,
    );
    expect(summary).toEqual({ confirmed: 1, unconfirmed: 0, notChecked: 2 });
  });

  it("stops when the run is aborted", async () => {
    const h = harness({}, () => true);
    const summary = await verifyCandidates(
      [{ finding: finding(1), stepId: "a", replay: async () => ({ confirmed: true, note: "ok" }) }],
      h.deps,
    );
    expect(summary.notChecked).toBe(1);
  });

  it("scrubs secrets from the note before it becomes an event", async () => {
    const h = harness();
    await verifyCandidates(
      [
        {
          finding: finding(1),
          stepId: "a",
          replay: async () => ({ confirmed: true, note: "Sent hunter2-secret and got 200." }),
        },
      ],
      h.deps,
    );
    await h.emitter.flush();
    expect(JSON.stringify(h.sink.events)).not.toContain("hunter2-secret");
  });
});
