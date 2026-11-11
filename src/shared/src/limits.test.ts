import { describe, expect, it } from "vitest";
import * as shared from "./index.js";
import * as server from "./server.js";
import {
  AGENTS,
  AREAS,
  DEMO_RUN_ID,
  TIER_IDS,
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
    createRunState({ runId: DEMO_RUN_ID, tier: "siege", areas: AREAS, agents: AGENTS }),
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
    expect(tierLimits.scout.spendCapUsd).toBe(1);
    expect(tierLimits.scout.tokenCap).toEqual({ input: 600000, output: 30000 });
    expect(tierLimits.siege.tokenCap).toEqual({ input: 4500000, output: 200000 });
    expect(server.limitsFor("siege").spendCapUsd).toBe(15);
  });

  it("raises every cap with depth", () => {
    const order = TIER_IDS.map((id) => tierLimits[id]);
    for (const [i, limits] of order.entries()) {
      if (i === 0) continue;
      expect(limits.spendCapUsd).toBeGreaterThan(order[i - 1]!.spendCapUsd);
      expect(limits.requestCap).toBeGreaterThan(order[i - 1]!.requestCap);
    }
  });

  it("rejects invalid limits", () => {
    expect(server.tierLimitsSchema.safeParse({ ...tierLimits.scout, spendCapUsd: 0 }).success).toBe(
      false,
    );
    expect(server.tierLimitsConfigSchema.safeParse({ scout: tierLimits.scout }).success).toBe(
      false,
    );
    expect(
      server.tierLimitsConfigSchema.safeParse({
        ...tierLimits,
        siege: { ...tierLimits.siege, spendCapUsd: 0.5 },
      }).success,
    ).toBe(false);
  });
});
