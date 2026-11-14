import {
  applyEvents,
  buildReport,
  createRunState,
  summarise,
  tierRoster,
  tiers,
  type Finding,
  type TierId,
} from "@swarm/shared";
import {
  dynamicResultsSchema,
  engagementSchema,
  gateFor,
  layerRoot,
  learningConfig,
  MemoryLearningStorage,
  pinLayer,
  readActive,
  updateStats,
  type AgentInput,
} from "@swarm/shared/server";
import expected from "@swarm/synthetic-target/expected.json" with { type: "json" };
import { describe, expect, it, vi } from "vitest";
import { MemorySink } from "./emitter.js";
import { runLearningPass, type RunData } from "./learning/index.js";
import { createOfflineLlm } from "./llm/offline.js";
import { runLocal } from "./local.js";
import {
  browserAvailable,
  call,
  fakeDns,
  inputFor,
  launch,
  ScriptedLlm,
  stamped,
  useTarget,
} from "./testkit.js";

// Every browser run launches Chromium, and a deep run signs in several times.
vi.setConfig({ testTimeout: 240_000 });

const target = useTarget();
const SLOTS = ["admin", "user1", "user2"] as const;
const NOW = new Date("2026-11-14T02:00:00.000Z");
const LIVE = layerRoot(false);

const LEARNED = expected.learned[0]!;

/** One run of the synthetic target under whatever the layer currently says. */
async function run(tier: TierId, storage: MemoryLearningStorage) {
  const active = await readActive(storage, LIVE, NOW);
  const dynamic = active ? pinLayer(active.snapshot, active.stats) : null;
  const slots = tiers[tier].logins === 0 ? [] : SLOTS.slice(0, Math.min(tiers[tier].logins, 3));
  const base = inputFor(target.port(), tier, {
    slots: slots.length ? slots : ["admin"],
    logins: slots.length > 0,
  });
  const input: AgentInput = { ...base, dynamic };
  const sink = new MemorySink();
  const local = await runLocal({
    input,
    sink,
    allowPrivate: true,
    llm: createOfflineLlm(),
    driverFactory: launch,
    dns: fakeDns,
  });
  const events = stamped(sink);
  const { agents, areas } = tierRoster(tier);
  const state = applyEvents(createRunState({ runId: input.runId, tier, areas, agents }), events);
  return { ...local, events, state, input };
}

type Run = Awaited<ReturnType<typeof run>>;

/** What the learning pass is given of a finished run (what the API's loader builds from S3). */
function reviewed(r: Run): RunData {
  const summary = { ...summarise(r.state), status: "complete" as const };
  const report = buildReport({
    state: { ...r.state, status: "complete", summary },
    events: r.events,
    summary,
    target: "127.0.0.1",
    generatedAt: r.events.at(-1)!.ts,
    profile: r.result.profile,
    engagement: r.result.engagement,
  });
  return {
    runId: r.input.runId,
    tier: r.input.tier,
    test: true,
    report,
    engagement: r.result.engagement,
    profile: r.result.profile,
    results: r.result.dynamic ? dynamicResultsSchema.parse(r.result.dynamic) : null,
    input: {
      hosts: r.input.scope.hosts,
      urls: [r.input.target.appUrl],
      logins: Object.values(r.input.logins).map((l) => ({
        username: l.username,
        password: l.password,
        description: l.description,
        notes: l.notes,
      })),
      scopeNotes: "",
    },
    pages: r.result.explorerLog?.pages ?? [],
  };
}

const wanted = (tier: TierId, logins: number) =>
  expected.findings.filter((f) => {
    const needs = "minLogins" in f ? f.minLogins : "needsLogin" in f && f.needsLogin ? 1 : 0;
    return tiers[tier].agents.includes(f.agent) && logins >= (needs ?? 0);
  });

const score = (found: readonly Finding[], want: ReturnType<typeof wanted>) => ({
  recall:
    want.filter((w) => found.some((f) => f.agent === w.agent && f.title.includes(w.titleIncludes)))
      .length / want.length,
  stray: found.filter(
    (f) => !want.some((w) => w.agent === f.agent && f.title.includes(w.titleIncludes)),
  ),
});

/** The model's answer to a source that talks about exposed debug endpoints. */
const proposal = {
  addItems: [
    {
      id: "k-exposed-debug-endpoints",
      title: "Exposed debug endpoints",
      description:
        "Runtime variable, profiling and metrics endpoints left reachable in production reveal how an application is built and run.",
      appliesTo: ["any"],
      sourceId: "owasp-top10",
      severityHint: "medium",
    },
  ],
  addAgents: [
    {
      id: "dyn-debug-vars",
      title: "Debug variables",
      objective: "Look for runtime variables that an application serves to anyone who asks.",
      area: "unauth",
      appliesTo: ["any"],
      sourceId: "owasp-top10",
      checks: [
        {
          kind: "probe",
          id: "vars",
          label: "Runtime variables endpoint",
          method: "GET",
          paths: ["/debug/vars"],
          match: { bodyIncludes: ["memstats", "cmdline"] },
          finding: {
            title: LEARNED.titleIncludes,
            severity: "medium",
            description:
              "An endpoint serves the runtime's variables, including its command line and memory statistics, to anyone who asks.",
            remediation:
              "Remove the endpoint, or serve it only to administrators on an internal network.",
            mapping: "OWASP A02:2025 Security Misconfiguration",
          },
        },
      ],
    },
  ],
};

const source = async (url: string) => {
  const res = new Response(
    url.includes("known_exploited")
      ? JSON.stringify({ vulnerabilities: [] })
      : "<html><body><p>Security misconfiguration: debug endpoints such as runtime variables are left reachable in production.</p></body></html>",
    {
      status: 200,
      headers: {
        "content-type": url.includes("known_exploited") ? "application/json" : "text/html",
      },
    },
  );
  Object.defineProperty(res, "url", { value: url });
  return res;
};

describe.skipIf(!browserAvailable)("the learning loop on the synthetic target", () => {
  it("a new risk category reaches later runs without a code change: shadow, then active, and the Phase 7 results stay as they were", async () => {
    const storage = new MemoryLearningStorage();
    const cfg = { ...learningConfig, limits: { ...learningConfig.limits, shadowRuns: 1 } };
    const learner = () =>
      new ScriptedLlm(() => [call(1, "record_learning", proposal)], {
        modelId: learningConfig.learnerModelId,
      });
    const pass = (r: Run, llm = learner()) =>
      runLearningPass({
        storage,
        root: LIVE,
        llm,
        fetch: source,
        now: () => NOW,
        holder: "t",
        trigger: "run",
        apply: true,
        run: reviewed(r),
        config: cfg,
      });

    // Run 1: the layer is the seed. A Siege run is what it was in Phase 7, and records the layer it used.
    const first = await run("siege", storage);
    const want = wanted("siege", 3);
    expect(want).toHaveLength(19);
    expect(score(first.state.findings, want)).toMatchObject({ recall: 1, stray: [] });
    expect(first.state.findings.every((f) => f.verified)).toBe(true);
    const plan1 = engagementSchema.parse(first.result.engagement);
    expect(plan1.dynamic.version).toBe(1);
    expect(plan1.dynamic.items.length).toBeGreaterThan(0);
    expect(plan1.dynamic.agents).toEqual([]);

    // The learner adds an item the baseline does not have and a dynamic agent for it: both candidates.
    const learned = await pass(first);
    expect(learned).toMatchObject({ outcome: "changed", version: 2 });
    const v2 = (await readActive(storage, LIVE, NOW))!;
    expect(v2.snapshot.items.find((i) => i.id === "k-exposed-debug-endpoints")!.status).toBe(
      "candidate",
    );
    expect(v2.snapshot.agents[0]).toMatchObject({ id: "dyn-debug-vars", status: "candidate" });

    // Run 2: the candidate observes. It would have raised the seeded issue, but raises nothing, and
    // the swarm's own results are exactly what they were.
    const second = await run("siege", storage);
    expect(score(second.state.findings, want)).toMatchObject({ recall: 1, stray: [] });
    expect(second.state.agents["dyn-debug-vars"]).toBeUndefined();
    expect(second.events.some((e) => e.agent === "dyn-debug-vars")).toBe(false);
    const plan2 = engagementSchema.parse(second.result.engagement);
    expect(plan2.dynamic).toMatchObject({
      version: 2,
      agents: [{ id: "dyn-debug-vars", mode: "shadow" }],
    });
    expect(plan2.dynamic.items.find((i) => i.id === "k-exposed-debug-endpoints")?.mode).toBe(
      "shadow",
    );
    expect(second.result.dynamic!.agents).toEqual([
      {
        id: "dyn-debug-vars",
        mode: "shadow",
        checks: 1,
        fired: 1,
        errors: 0,
        outOfScope: 0,
        unconfirmed: 0,
      },
    ]);
    expect(second.result.dynamic!.wouldRaise).toEqual([
      {
        agent: "dyn-debug-vars",
        check: "vars",
        title: LEARNED.titleIncludes,
        component: "GET /debug/vars",
      },
    ]);

    // It is not promoted without a passing regression on the synthetic target; with one, it is.
    const unpromoted = await pass(
      second,
      new ScriptedLlm(() => [call(1, "record_learning", {})], {
        modelId: learningConfig.learnerModelId,
      }),
    );
    expect(unpromoted.lifecycle).toEqual([]);
    await updateStats(storage, LIVE, (s) => ({
      ...s,
      gate: gateFor({
        version: 2,
        runId: "run_gate0001",
        expected: want.length,
        found: want.length,
        stray: 0,
        now: NOW,
      }),
    }));
    const promoted = await pass(
      second,
      new ScriptedLlm(() => [call(1, "record_learning", {})], {
        modelId: learningConfig.learnerModelId,
      }),
    );
    expect(promoted.lifecycle).toEqual(
      expect.arrayContaining([
        "promoted dyn-debug-vars to active",
        "promoted k-exposed-debug-endpoints to active",
      ]),
    );
    expect((await readActive(storage, LIVE, NOW))!.snapshot.version).toBeGreaterThan(2);

    // Run 3: the learned agent is active. It appears in the swarm like any agent, finds the seeded
    // issue, and the verifier confirms it; everything else is unchanged.
    const third = await run("siege", storage);
    expect(score(third.state.findings, want)).toMatchObject({ recall: 1 });
    const extra = third.state.findings.filter((f) => f.agent === "dyn-debug-vars");
    expect(extra).toHaveLength(1);
    expect(extra[0]).toMatchObject({
      title: LEARNED.titleIncludes,
      severity: "medium",
      area: "unauth",
      verified: true,
      status: "open",
    });
    expect(score(third.state.findings, want).stray.map((f) => f.agent)).toEqual(["dyn-debug-vars"]);
    expect(third.state.agents["dyn-debug-vars"]).toMatchObject({
      status: "done",
      progress: 1,
      spec: { name: "Debug variables", area: "unauth" },
    });
    const dispatch = third.events.find(
      (e) => e.type === "dispatch" && e.agent === "dyn-debug-vars",
    );
    expect(dispatch).toMatchObject({
      payload: { spec: { id: "dyn-debug-vars", area: "unauth", steps: [{ id: "vars" }] } },
    });
    expect(third.result.dynamic!.agents[0]).toMatchObject({
      mode: "active",
      checks: 1,
      fired: 1,
      unconfirmed: 0,
    });
    expect(engagementSchema.parse(third.result.engagement).dynamic.agents[0]).toMatchObject({
      id: "dyn-debug-vars",
      mode: "active",
      source: { name: "OWASP Top 10" },
    });

    // The report says which learned entries were used, with their source and date.
    const report = reviewed(third).report;
    expect(report.dynamic).toMatchObject({
      agents: [
        {
          id: "dyn-debug-vars",
          mode: "active",
          source: { name: "OWASP Top 10", date: "2026-11-14" },
        },
      ],
    });
    expect(
      report.phases
        .find((p) => p.area === "unauth")!
        .checks.some((c) => c.agent === "dyn-debug-vars" && c.outcome === "finding"),
    ).toBe(true);

    // Only reads: the learned check sent one safe request to a generic path.
    const writes = target
      .target()
      .seen.filter((r) => !["GET", "HEAD", "OPTIONS"].includes(r.method));
    expect(writes.every((r) => r.method === "POST" && r.path === "/api/login")).toBe(true);
    expect(target.target().seen.some((r) => r.path === "/debug/vars")).toBe(true);
  });

  it("Scout and Sweep run no dynamic agents, whatever the layer holds", async () => {
    const storage = new MemoryLearningStorage();
    const cfg = { ...learningConfig, limits: { ...learningConfig.limits, shadowRuns: 1 } };
    // A layer with an active agent in it.
    await runLearningPass({
      storage,
      root: LIVE,
      llm: new ScriptedLlm(() => [call(1, "record_learning", proposal)], {
        modelId: learningConfig.learnerModelId,
      }),
      fetch: source,
      now: () => NOW,
      holder: "t",
      trigger: "manual",
      apply: true,
      run: null,
      force: true,
      config: cfg,
    });
    const before = target.target().seen.length;
    for (const tier of ["scout", "sweep"] as const) {
      const r = await run(tier, storage);
      expect([...r.result.agentsRun].sort()).toEqual([...tiers[tier].agents].sort());
      expect(r.result.dynamic).toBeNull();
      expect(r.result.engagement).toBeNull();
      expect(r.events.some((e) => e.agent === "dyn-debug-vars")).toBe(false);
    }
    expect(
      target
        .target()
        .seen.slice(before)
        .some((r) => r.path === "/debug/vars"),
    ).toBe(false);
  });
});
