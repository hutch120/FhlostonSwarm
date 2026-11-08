import { describe, expect, it } from "vitest";
import * as shared from "./index.js";
import * as server from "./server.js";
import {
  AGENTS,
  AREAS,
  DEMO_RUN_ID,
  applyEvents,
  createRunState,
  replayEvents,
  summarise,
  tiers,
} from "./index.js";
import { tierLimits } from "./server.js";

/** Keys that would reveal what a run costs us or how our cost controls are set. */
const COST_KEY = /spend|usd|cost|price|token|model|cap$|budget|concurrency/i;

function costKeys(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => costKeys(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, v]) => [
      ...(COST_KEY.test(key) ? [`${path}.${key}`] : []),
      ...costKeys(v, `${path}.${key}`),
    ]);
  }
  return [];
}

describe("customer-facing data never exposes cost (revenue.md section 2)", () => {
  const finished = applyEvents(
    createRunState({ runId: DEMO_RUN_ID, tier: "full", areas: AREAS, agents: AGENTS }),
    replayEvents,
  );

  it("has no cost fields on any event", () => {
    expect(costKeys(replayEvents)).toEqual([]);
  });

  it("has no cost fields on the summary or run state", () => {
    expect(costKeys(summarise(finished))).toEqual([]);
    expect(costKeys(finished.summary)).toEqual([]);
    expect(costKeys({ ...finished, log: [] })).toEqual([]);
  });

  it("has no cost fields in the public tier config", () => {
    expect(costKeys(tiers)).toEqual([]);
  });

  it("keeps limits off the package root", () => {
    expect(Object.keys(shared).filter((k) => /limit/i.test(k))).toEqual([]);
    expect(Object.keys(server)).toEqual(
      expect.arrayContaining(["tierLimits", "limitsFor", "tierLimitsSchema"]),
    );
  });
});

describe("server-only tier limits", () => {
  it("parses the shipped limits", () => {
    expect(tierLimits.lite.spendCapUsd).toBe(0.5);
    expect(tierLimits.lite.tokenCap).toEqual({ input: 400000, output: 20000 });
    expect(tierLimits.full.tokenCap).toBeNull();
    expect(server.limitsFor("full").spendCapUsd).toBe(15);
  });

  it("rejects invalid limits", () => {
    expect(server.tierLimitsSchema.safeParse({ ...tierLimits.lite, spendCapUsd: 0 }).success).toBe(
      false,
    );
    expect(server.tierLimitsConfigSchema.safeParse({ lite: tierLimits.lite }).success).toBe(false);
  });
});
