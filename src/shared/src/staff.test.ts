import { describe, expect, it } from "vitest";
import { RUNS_PER_YEAR, suggestPrice } from "./index.js";
import { estimateCost, pricing, repriceUsage, usageOf, type Pricing } from "./server.js";

const MODEL = "au.anthropic.claude-haiku-4-5-20251001-v1:0";

const run = {
  runId: "run_x",
  tier: "sweep" as const,
  startedAt: "2026-11-14T00:00:00.000Z",
  finishedAt: "2026-11-14T00:10:00.000Z",
  taskSeconds: 600,
  bytesOut: 1024 ** 3,
  bytesIn: 0,
  requests: 10,
  checks: 5,
  bedrock: { modelId: MODEL, calls: 4, inputTokens: 1_000_000, outputTokens: 100_000, usd: 99 },
};

describe("pricing worksheet", () => {
  it("prices at the cost plus a margin, rounded up to the cent, never below the floor", () => {
    expect(suggestPrice(1, 0.5)).toBe(1.5);
    expect(suggestPrice(0.333, 1)).toBe(0.67);
    expect(suggestPrice(0.1, 1, 1)).toBe(1);
    expect(suggestPrice(0, 1, 0)).toBe(0);
  });

  it("annualises a cadence by the runs in a year", () => {
    expect(RUNS_PER_YEAR).toEqual({ daily: 365, weekly: 52, monthly: 12, yearly: 1 });
  });
});

describe("costing a run again", () => {
  it("prices the tokens from the table, not from the figure the task reported", () => {
    const cost = estimateCost(run);
    // 1M in at US$1 + 0.1M out at US$5 per million.
    expect(cost.bedrock.usd).toBeCloseTo(1.5, 9);
    expect(cost.bedrock.modelId).toBe(MODEL);
  });

  it("keeps the task's own figure for a model the table does not list", () => {
    const cost = estimateCost({ ...run, bedrock: { ...run.bedrock, modelId: "au.unlisted" } });
    expect(cost.bedrock.usd).toBe(99);
  });

  it("gives the same total from the usage and the same table, and a different one from another table", () => {
    const cost = estimateCost(run);
    const same = repriceUsage(usageOf(cost), pricing, cost.bedrock.usd);
    expect(same.totalUsd).toBeCloseTo(cost.totalUsd, 5);

    const dearer: Pricing = {
      ...pricing,
      bedrock: { ...pricing.bedrock, [MODEL]: { inputPerMTok: 2, outputPerMTok: 10 } },
    };
    const again = repriceUsage(usageOf(cost), dearer, cost.bedrock.usd);
    expect(again.bedrockUsd).toBeCloseTo(3, 9);
    expect(again.totalUsd - same.totalUsd).toBeCloseTo(1.5, 5);
    // Only the model changed: everything else costs what it did.
    expect(again.fargateUsd).toBe(same.fargateUsd);
    expect(again.egressUsd).toBe(same.egressUsd);
  });

  it("keeps the recorded model cost when the table lacks the model", () => {
    const cost = estimateCost(run);
    const without: Pricing = { ...pricing, bedrock: {} };
    expect(repriceUsage(usageOf(cost), without, 1.5).bedrockUsd).toBe(1.5);
  });
});
