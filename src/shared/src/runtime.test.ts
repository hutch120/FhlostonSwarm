import { describe, expect, it } from "vitest";
import {
  AGENTS,
  DEMO_RUN_ID,
  REPORT_DISCLAIMER,
  applyEvents,
  buildReport,
  createRunState,
  replayEvents,
  runReportSchema,
  summarise,
  tierRoster,
  tiers,
} from "./index.js";
import {
  agentInputSchema,
  bedrockUsd,
  estimateCost,
  isReservedAddress,
  limitsFor,
  pricing,
  pricingSchema,
  runCostSchema,
  runtimeConfig,
  runtimeConfigSchema,
  scopePorts,
} from "./server.js";

describe("run infrastructure config", () => {
  it("parses the shipped runtime and pricing config", () => {
    expect(runtimeConfig.agentTask).toEqual({ vcpu: 1, memoryGb: 2 });
    expect(pricing.version).toMatch(/^\d{4}-\d{2}-\d{2}/);
    // Every model a depth uses has a price, or its runs could not be costed.
    for (const tier of ["scout", "sweep", "probe", "siege"] as const) {
      expect(pricing.bedrock[limitsFor(tier).modelId], tier).toBeDefined();
    }
  });

  it("rejects invalid config", () => {
    expect(runtimeConfigSchema.safeParse({ ...runtimeConfig, proxyPort: 80 }).success).toBe(false);
    expect(pricingSchema.safeParse({ ...pricing, egressPerGb: -1 }).success).toBe(false);
    expect(pricingSchema.safeParse({ ...pricing, currency: "AUD" }).success).toBe(false);
  });

  it("gives every depth a check budget that grows with depth", () => {
    const caps = (["scout", "sweep", "probe", "siege"] as const).map((t) => limitsFor(t).stepCap);
    expect([...caps].sort((a, b) => a - b)).toEqual(caps);
  });
});

describe("cost estimate", () => {
  const base = {
    runId: "run_abc12345",
    tier: "sweep" as const,
    startedAt: "2026-11-10T00:00:00.000Z",
    finishedAt: "2026-11-10T00:05:00.000Z",
    taskSeconds: 300,
    bytesOut: 1024 ** 3,
    bytesIn: 5 * 1024 ** 3,
    requests: 40,
    checks: 11,
  };

  it("prices Fargate by size and time, egress by bytes out, and leaves Bedrock empty", () => {
    const cost = estimateCost(base);
    expect(runCostSchema.safeParse(cost).success).toBe(true);
    // The configured task size for 300 s.
    const { vcpu, memoryGb } = runtimeConfig.agentTask;
    const expectedFargate =
      (300 / 3600) * (vcpu * pricing.fargate.vcpuPerHour + memoryGb * pricing.fargate.gbPerHour);
    expect(cost.fargate.usd).toBeCloseTo(expectedFargate, 5);
    expect(cost.egress.usd).toBeCloseTo(pricing.egressPerGb, 5);
    expect(cost.bedrock).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 });
    expect(cost.totalUsd).toBeCloseTo(
      cost.fargate.usd + cost.egress.usd + cost.orchestration.usd,
      5,
    );
    expect(cost.durationSeconds).toBe(300);
    expect(cost.pricingVerified).toBe(false);
  });

  it("bills at least one minute per task, and nothing for a run that never started a task", () => {
    expect(estimateCost({ ...base, taskSeconds: 5 }).fargate.taskSeconds).toBe(60);
    expect(estimateCost({ ...base, taskSeconds: 0 }).fargate.usd).toBe(0);
  });

  it("keeps the prices it was costed with", () => {
    const cheap = { ...pricing, version: "test", fargate: { vcpuPerHour: 0, gbPerHour: 0 } };
    expect(estimateCost(base, cheap).fargate.usd).toBe(0);
    expect(estimateCost(base, cheap).pricingVersion).toBe("test");
  });

  it("prices model use from the table and refuses an unpriced model", () => {
    const model = limitsFor("scout").modelId;
    const price = pricing.bedrock[model]!;
    expect(bedrockUsd(model, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(
      price.inputPerMTok + price.outputPerMTok,
      6,
    );
    expect(() => bedrockUsd("au.unknown-model", { inputTokens: 1, outputTokens: 1 })).toThrow(
      /no Bedrock price/,
    );
    const withModel = estimateCost({
      ...base,
      bedrock: { calls: 3, inputTokens: 1000, outputTokens: 100, usd: 0.0015 },
    });
    expect(withModel.bedrock).toEqual({
      calls: 3,
      inputTokens: 1000,
      outputTokens: 100,
      usd: 0.0015,
    });
    expect(withModel.totalUsd).toBeGreaterThan(estimateCost(base).totalUsd);
  });
});

describe("agent input", () => {
  it("requires at least one host and a password on every login", () => {
    const valid = {
      runId: "run_abc12345",
      tier: "scout",
      target: { appUrl: "https://a.example.com", marketingUrl: "" },
      scope: { hosts: ["a.example.com"], ports: [80, 443], readOnly: true, loginSubmissions: 0 },
      agents: ["tls"],
      budgets: {
        wallClockSeconds: 600,
        maxSteps: 10,
        maxRequests: 50,
        requestsPerSecond: 2,
        maxPages: 10,
        llm: {
          modelId: "m",
          maxCalls: 10,
          phaseCalls: 5,
          maxInputTokens: 1000,
          maxOutputTokens: 100,
          spendCapUsd: 1,
        },
      },
      logins: {},
      scopeNotes: "",
      userAgent: "Swarm/0.1",
    };
    expect(agentInputSchema.safeParse(valid).success).toBe(true);
    expect(
      agentInputSchema.safeParse({ ...valid, scope: { ...valid.scope, hosts: [] } }).success,
    ).toBe(false);
    expect(
      agentInputSchema.safeParse({
        ...valid,
        logins: { user1: { username: "u", description: "d", notes: "" } },
      }).success,
    ).toBe(false);
  });
});

describe("address and port rules", () => {
  it.each([
    ["169.254.169.254", true],
    ["169.254.170.2", true],
    ["10.0.0.1", true],
    ["127.0.0.1", true],
    ["::1", true],
    ["fd00:ec2::254", true],
    ["8.8.8.8", false],
    ["2606:4700:4700::1111", false],
  ])("%s reserved: %s", (address, reserved) => {
    expect(isReservedAddress(address)).toBe(reserved);
  });

  it("adds explicit ports to 80 and 443", () => {
    expect(scopePorts(["http://x.test:8080/", "https://y.test/", ""])).toEqual([80, 443, 8080]);
    expect(scopePorts(["not a url"])).toEqual([80, 443]);
  });
});

describe("tier roster and report data", () => {
  it("lists only the agents a tier runs, and the areas they belong to", () => {
    const scout = tierRoster("scout");
    expect(scout.agents.map((a) => a.id)).toEqual(tiers.scout.agents);
    expect(scout.areas.map((a) => a.id)).toEqual(["recon", "unauth"]);
    expect(tierRoster("siege").agents).toHaveLength(AGENTS.length);
  });

  it("builds report data from a finished run and has no cost fields", () => {
    const state = applyEvents(
      createRunState({
        runId: DEMO_RUN_ID,
        tier: "siege",
        areas: tierRoster("siege").areas,
        agents: AGENTS,
      }),
      replayEvents,
    );
    const summary = summarise(state);
    const report = buildReport({
      state,
      events: replayEvents,
      summary,
      target: "portal.example.com",
      generatedAt: "2026-11-10T00:00:00.000Z",
    });
    expect(runReportSchema.safeParse(report).success).toBe(true);
    expect(report.findings).toHaveLength(state.findings.length);
    expect(report.passed.length).toBeGreaterThan(0);
    expect(report.disclaimer).toBe(REPORT_DISCLAIMER);
    const keys = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.flatMap(keys)
        : value && typeof value === "object"
          ? Object.entries(value).flatMap(([k, v]) => [k, ...keys(v)])
          : [];
    expect(keys(report).filter((k) => /usd|cost|price|spend|budget|token|model/i.test(k))).toEqual(
      [],
    );
  });
});
