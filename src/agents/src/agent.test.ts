import type { AddressInfo } from "node:net";
import type http from "node:http";
import { applyEvents, createRunState, runEventSchema, stampEvent, tierRoster } from "@swarm/shared";
import type { RunEvent } from "@swarm/shared";
import type { AgentInput } from "@swarm/shared/server";
import expected from "@swarm/synthetic-target/expected.json" with { type: "json" };
import { createTarget } from "@swarm/synthetic-target";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemorySink } from "./emitter.js";
import { runLocal } from "./local.js";

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = createTarget();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const inputFor = (overrides: Partial<AgentInput> = {}): AgentInput => ({
  runId: "run_test0001",
  tier: "sweep",
  target: { appUrl: `http://127.0.0.1:${port}/`, marketingUrl: "" },
  scope: { hosts: ["127.0.0.1"], ports: [80, 443, port], readOnly: true },
  agents: ["dns", "surface", "bundle", "tls", "zap", "cors", "authn"],
  budgets: { wallClockSeconds: 120, maxSteps: 80, maxRequests: 800, requestsPerSecond: 500 },
  logins: {},
  scopeNotes: "",
  userAgent: "Swarm/0.1 (+https://fhlostonswarm.com/about)",
  ...overrides,
});

/** What the events API does: give each agent event its seq, in arrival order. */
const stamped = (sink: MemorySink): RunEvent[] =>
  sink.events.map((event, i) => stampEvent(event, i + 1));

describe("headers agent against the synthetic target", () => {
  it("raises exactly the findings in expected.json", async () => {
    const sink = new MemorySink();
    const { result } = await runLocal({ input: inputFor(), sink, allowPrivate: true });
    const events = stamped(sink);

    const raised = events.flatMap((e) =>
      e.type === "finish" && e.payload.outcome === "finding"
        ? [{ agent: e.agent, step: e.payload.stepId, finding: e.payload.finding }]
        : [],
    );
    expect(raised).toHaveLength(expected.findings.length);
    for (const want of expected.findings) {
      const got = raised.find((r) => r.agent === want.agent && r.step === want.step);
      expect(got, `${want.agent}.${want.step}`).toBeDefined();
      expect(got!.finding.severity).toBe(want.severity);
      expect(got!.finding.title).toContain(want.titleIncludes);
    }
    expect(result.findings).toHaveLength(expected.findings.length);
  });

  it("emits events that validate against the shared schema and fold into a sound run state", async () => {
    const sink = new MemorySink();
    await runLocal({ input: inputFor(), sink, allowPrivate: true });
    const events = stamped(sink);
    for (const event of events) expect(runEventSchema.safeParse(event).success).toBe(true);

    const { agents, areas } = tierRoster("sweep");
    const state = applyEvents(
      createRunState({ runId: "run_test0001", tier: "sweep", areas, agents }),
      events,
    );
    // tls, zap and cors ran every step; the other four roster agents are reported as gaps.
    for (const id of ["tls", "zap", "cors"]) {
      expect(state.agents[id]).toMatchObject({ status: "done", progress: 1 });
    }
    for (const id of ["dns", "surface", "bundle", "authn"]) {
      expect(state.agents[id]).toMatchObject({ status: "idle", progress: 0 });
    }
    expect(state.gaps.map((g) => g.agent).sort()).toEqual(["authn", "bundle", "dns", "surface"]);
    expect(state.findings).toHaveLength(expected.findings.length);
    expect(state.findings.every((f) => f.verified === false)).toBe(true);
  });

  it("only runs the planned agents (Scout has no scanner)", async () => {
    const sink = new MemorySink();
    const scout = inputFor({ tier: "scout", agents: ["dns", "surface", "tls", "cors"] });
    const { result } = await runLocal({ input: scout, sink, allowPrivate: true });
    expect(result.agentsRun).toEqual(["tls", "cors"]);
    expect(sink.events.some((e) => e.type === "dispatch" && e.agent === "zap")).toBe(false);
  });

  it("goes through the proxy only, and logs every request", async () => {
    const sink = new MemorySink();
    const { stats, log } = await runLocal({ input: inputFor(), sink, allowPrivate: true });
    expect(stats.requests).toBeGreaterThan(5);
    expect(stats.blocked).toBe(0);
    expect(log.entries.every((e) => e.host === "127.0.0.1" && e.decision === "allowed")).toBe(true);
    // Every request the agent counted went through the proxy.
    const counted = sink.events.reduce(
      (n, e) => n + (e.type === "finish" ? e.payload.requests : 0),
      0,
    );
    expect(counted).toBe(stats.requests);
  });

  it("is refused when the proxy would reach a private address (no allowPrivate)", async () => {
    const sink = new MemorySink();
    const { result } = await runLocal({ input: inputFor(), sink });
    expect(result.findings).toHaveLength(0);
    const gaps = sink.events.filter((e) => e.type === "gap");
    expect(gaps.length).toBeGreaterThan(3);
  });

  it("turns an exhausted request budget into gaps instead of stopping silently", async () => {
    const sink = new MemorySink();
    const input = inputFor({
      budgets: { wallClockSeconds: 120, maxSteps: 80, maxRequests: 4, requestsPerSecond: 500 },
    });
    const { result } = await runLocal({ input, sink, allowPrivate: true });
    expect(result.stoppedBy).toBe("requests");
    const gaps = sink.events.filter((e) => e.type === "gap");
    expect(gaps.some((g) => g.type === "gap" && /request budget/i.test(g.payload.reason))).toBe(
      true,
    );
    expect(result.findings.length).toBeLessThan(expected.findings.length);
  });

  it("stops at the step budget", async () => {
    const sink = new MemorySink();
    const input = inputFor({
      budgets: { wallClockSeconds: 120, maxSteps: 3, maxRequests: 800, requestsPerSecond: 500 },
    });
    const { result } = await runLocal({ input, sink, allowPrivate: true });
    expect(result.stoppedBy).toBe("steps");
    expect(result.checks).toBeLessThanOrEqual(3);
  });

  it("stops when told to (SIGTERM)", async () => {
    const sink = new MemorySink();
    let calls = 0;
    const { result } = await runLocal({
      input: inputFor(),
      sink,
      allowPrivate: true,
      aborted: () => ++calls > 2,
    });
    expect(result.stoppedBy).toBe("aborted");
  });
});

describe("roster coverage", () => {
  it("implements every roster step of the agents it provides", async () => {
    const { MODULES } = await import("./runner.js");
    const { AGENTS } = await import("@swarm/shared");
    for (const [id, module] of Object.entries(MODULES)) {
      const spec = AGENTS.find((a) => a.id === id)!;
      expect(Object.keys(module.steps).sort()).toEqual(spec.steps.map((s) => s.id).sort());
    }
  });
});
