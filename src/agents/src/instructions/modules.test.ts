import { AGENTS, tiers } from "@swarm/shared";
import { GUARDRAILS, INSTRUCTIONS_VERSION } from "@swarm/shared/server";
import { describe, expect, it } from "vitest";
import { INSTRUCTION_MODULES, guardrailText, renderModule, renderModules } from "./modules.js";

describe("instruction modules", () => {
  it("cover every roster step exactly once", () => {
    const covered = INSTRUCTION_MODULES.flatMap((m) => m.checks.map((c) => `${c.agent}.${c.step}`));
    const roster = AGENTS.flatMap((a) => a.steps.map((s) => `${a.id}.${s.id}`));
    expect([...covered].sort()).toEqual([...roster].sort());
  });

  it("number the methodology phases 1 to 6 in order, and map to the roster areas", () => {
    expect(INSTRUCTION_MODULES.map((m) => m.phase)).toEqual([1, 2, 3, 4, 5, 6]);
    const areaOf = new Map(AGENTS.map((a) => [a.id, a.area]));
    const phaseOfArea = { recon: 1, unauth: 2, authn: 3, llm: 4, logic: 5 } as const;
    for (const module of INSTRUCTION_MODULES) {
      for (const check of module.checks) {
        expect(phaseOfArea[areaOf.get(check.agent)!]).toBe(module.phase);
      }
    }
  });

  it("render every guardrail in every module, so none can be left out", () => {
    for (const module of INSTRUCTION_MODULES) {
      const text = renderModule(module);
      for (const guardrail of GUARDRAILS) expect(text).toContain(guardrail.text);
    }
    expect(guardrailText().split("\n")).toHaveLength(GUARDRAILS.length);
  });

  it("carry no engagement-specific content", () => {
    const text = JSON.stringify(INSTRUCTION_MODULES);
    expect(text).not.toMatch(/polynize|pwc|assessment1|@[a-z0-9-]+\.(io|com)|password\s*[:=]/i);
  });

  it("render only the phases a depth covers", () => {
    const sweep = renderModules(tiers.sweep.agents);
    expect(sweep).toContain("Phase 1");
    expect(sweep).not.toContain("AI / LLM security testing");
    expect(renderModules(tiers.siege.agents)).toContain("AI / LLM security testing");
  });

  it("has a version to record per run", () => {
    expect(INSTRUCTIONS_VERSION).toMatch(/^\d{4}\.\d{1,2}\.\d+$/);
  });
});
