import {
  DEMO_RUN_ID,
  DEMO_TARGET,
  applyEvents,
  buildReport,
  createRunState,
  replayEvents,
  tierRoster,
} from "@swarm/shared";
import {
  GUARDRAIL_IDS,
  INSTRUCTIONS_VERSION,
  MemoryLearningStorage,
  commitVersion,
  dynamicAgentSchema,
  emptyStats,
  ensureSeed,
  layerRoot,
  learningConfig,
  listVersions,
  pinLayer,
  readActive,
  readLogs,
  readStats,
  seedSnapshot,
  selectDynamic,
  setPointer,
  tokensOf,
  updateStats,
  type DynamicAgent,
  type Engagement,
  type LearningConfig,
  type LearningProposal,
} from "@swarm/shared/server";
import { describe, expect, it, vi } from "vitest";
import { RequestFailed, type HttpResult } from "./http.js";
import { DynamicRuntime, matches } from "./learning/dynamic.js";
import { gapKind, runStringsOf, type RunData } from "./learning/digest.js";
import { runLearningPass, type LearnOptions } from "./learning/learner.js";
import { htmlToText, kevToText, loadSources, type FetchLike } from "./learning/sources.js";
import type { ContentBlock, LlmClient, LlmRequest, LlmResponse } from "./llm/types.js";
import type { StepContext } from "./types.js";

const NOW = new Date("2026-11-14T01:00:00.000Z");
const LIVE = layerRoot(false);

// A model that does what a test scripts, and records every request it was sent ------------------

class FakeLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];
  constructor(
    private readonly script: (request: LlmRequest) => ContentBlock[] | Error,
    readonly modelId = "au.anthropic.claude-opus-4-6-v1",
    private readonly delayMs = 0,
  ) {}
  async converse(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(JSON.parse(JSON.stringify(request)) as LlmRequest);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const out = this.script(request);
    if (out instanceof Error) throw out;
    return {
      message: { role: "assistant", content: out },
      stopReason: "tool_use",
      usage: { inputTokens: 4000, outputTokens: 400 },
    };
  }
}

const record = (proposal: unknown): ContentBlock[] => [
  { type: "toolUse", id: "t1", name: "record_learning", input: proposal },
];

// Sources the learner reads (a stub of the network) ---------------------------------------------

const KEV = JSON.stringify({
  vulnerabilities: [
    {
      cveID: "CVE-2025-0001",
      vendorProject: "Vendorco",
      product: "Widget",
      vulnerabilityName: "Widget RCE",
      dateAdded: "2025-01-02",
    },
    {
      cveID: "CVE-2025-0002",
      vendorProject: "Foo",
      product: "Bar",
      vulnerabilityName: "Bar auth bypass",
      dateAdded: "2025-03-04",
    },
  ],
});

/** A response as fetch gives it: with the URL it was finally served from. */
const served = (body: string, type: string, url: string, status = 200): Response => {
  const res = new Response(body, { status, headers: { "content-type": type } });
  Object.defineProperty(res, "url", { value: url });
  return res;
};

function fetcher(
  options: { revision?: number; fail?: Set<string> } = {},
): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    if (options.fail?.has(url)) throw new Error("network down");
    const kev = url.includes("known_exploited");
    return served(
      kev
        ? KEV
        : `<html><head><style>x{}</style><script>evil()</script></head><body><h1>Risks</h1><p>Rev ${options.revision ?? 1}: broken access control &amp; injection.</p></body></html>`,
      kev ? "application/json" : "text/html; charset=utf-8",
      url,
    );
  }) as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}

// A closed run, as the learner reads it -----------------------------------------------------------

const engagement = (overrides: Partial<Engagement> = {}): Engagement => ({
  version: 1,
  runId: DEMO_RUN_ID,
  tier: "siege",
  instructionsVersion: INSTRUCTIONS_VERSION,
  dynamic: { version: 1, items: [], agents: [] },
  guardrails: [...GUARDRAIL_IDS],
  scope: { hosts: [DEMO_TARGET], readOnly: true },
  agents: tierRoster("siege").agents.map((a) => ({ id: a.id, enabled: true })),
  skippedChecks: [],
  roles: [{ slot: "admin", description: "Administrator", kind: "admin" }],
  matrix: [],
  hints: { routes: [], apiBases: ["/graphql"], ai: [] },
  budget: { wallClockSeconds: 3600, maxSteps: 400, maxRequests: 3000, spendCapUsd: 15 },
  plannedBy: "rules",
  notes: [],
  ...overrides,
});

function runData(extra: Partial<RunData> = {}): RunData {
  const { agents, areas } = tierRoster("siege");
  const state = applyEvents(
    createRunState({ runId: DEMO_RUN_ID, tier: "siege", areas, agents }),
    replayEvents,
  );
  const report = buildReport({
    state,
    events: replayEvents,
    summary: state.summary!,
    target: DEMO_TARGET,
    generatedAt: replayEvents.at(-1)!.ts,
  });
  return {
    runId: DEMO_RUN_ID,
    tier: "siege",
    test: false,
    report,
    engagement: engagement(),
    profile: null,
    results: null,
    input: { hosts: [DEMO_TARGET], urls: [`https://${DEMO_TARGET}/`], logins: [], scopeNotes: "" },
    pages: [],
    ...extra,
  };
}

const quietRun = (extra: Partial<RunData> = {}): RunData => {
  const base = runData({
    engagement: engagement({ hints: { routes: [], apiBases: [], ai: [] } }),
    ...extra,
  });
  return {
    ...base,
    report: {
      ...base.report,
      findings: base.report.findings.map((f) => ({
        ...f,
        verified: true,
        status: "open" as const,
      })),
    },
  };
};

const learnerOptions = (
  storage: MemoryLearningStorage,
  overrides: Partial<LearnOptions> = {},
): LearnOptions => ({
  storage,
  root: LIVE,
  llm: new FakeLlm(() => record({})),
  fetch: fetcher(),
  now: () => NOW,
  holder: "run_test0001",
  trigger: "run",
  apply: true,
  run: runData(),
  ...overrides,
});

const config = (
  limits: Partial<LearningConfig["limits"]> = {},
  learner: Partial<LearningConfig["learner"]> = {},
): LearningConfig => ({
  ...learningConfig,
  limits: { ...learningConfig.limits, ...limits },
  learner: { ...learningConfig.learner, ...learner },
});

const itemProposal = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: "GraphQL introspection",
  description: "Introspection left on in production lets anyone read the whole schema of the API.",
  appliesTo: ["graphql"],
  sourceId: "owasp-top10",
  severityHint: "medium",
  ...extra,
});

const agentProposal = (id: string, path = "/debug/vars") => ({
  id,
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
      paths: [path],
      match: { bodyIncludes: ["memstats"] },
      finding: {
        title: "Runtime debug variables are publicly readable",
        severity: "medium",
        description:
          "An endpoint serves the runtime's variables, including its command line and memory data.",
        remediation: "Remove the endpoint or restrict it to administrators on an internal network.",
      },
    },
  ],
});

const everything = async (storage: MemoryLearningStorage): Promise<string> =>
  (await storage.list("")).length === 0
    ? ""
    : (
        await Promise.all(
          (await storage.list("")).map(async (k) => `${k}\n${(await storage.get(k))!.body}`),
        )
      ).join("\n");

// The learning pass -----------------------------------------------------------------------------

describe("a learning pass reviews the closed run", () => {
  it("adds candidates for what the run missed, citing a listed source, and writes the version, counters and log", async () => {
    const storage = new MemoryLearningStorage();
    const llm = new FakeLlm(() =>
      record({
        addItems: [itemProposal("k-graphql-introspection")],
        addAgents: [agentProposal("dyn-debug-vars")],
      }),
    );
    const result = await runLearningPass(learnerOptions(storage, { llm }));

    expect(result).toMatchObject({ outcome: "changed", version: 2, model: llm.modelId });
    expect(result.cost).toMatchObject({ modelId: llm.modelId, calls: 1 });
    expect(result.cost!.usd).toBeGreaterThan(0);

    const active = (await readActive(storage, LIVE, NOW))!;
    expect(active.pointer.version).toBe(2);
    expect(active.snapshot.items.find((i) => i.id === "k-graphql-introspection")).toMatchObject({
      status: "candidate",
    });
    expect(active.snapshot.agents[0]).toMatchObject({ id: "dyn-debug-vars", status: "candidate" });
    expect(active.stats.runs).toBe(1);
    expect(Object.keys(active.stats.sources).sort()).toEqual(
      learningConfig.sources.map((s) => s.id).sort(),
    );

    const [log] = await readLogs(storage, LIVE);
    expect(log).toMatchObject({ outcome: "changed", fromVersion: 1, toVersion: 2, trigger: "run" });
    // The log says what was proposed and decided, never which run prompted it.
    expect(JSON.stringify(log)).not.toContain(DEMO_RUN_ID);
    expect(log!.proposal!.addItems[0]!.id).toBe("k-graphql-introspection");
    expect(log!.sources.map((s) => s.id).sort()).toEqual(
      learningConfig.sources.map((s) => s.id).sort(),
    );
    // The prompt carried the sources and the digest as untrusted data.
    const task = JSON.stringify(llm.requests[0]!.messages);
    expect(task).toContain("untrusted-content");
    expect(task).toContain("broken access control");
  });

  it("uses the model the config names for the learner, and falls back when it cannot be invoked", async () => {
    const storage = new MemoryLearningStorage();
    const unavailable = new FakeLlm(
      () =>
        Object.assign(new Error("anthropic.claude-sonnet-5-5 is not available for this account"), {
          name: "AccessDeniedException",
        }),
      "au.anthropic.claude-sonnet-5-5",
    );
    const fallback = new FakeLlm(
      () => record({ addItems: [itemProposal("k-from-fallback")] }),
      learningConfig.fallbackModelId,
    );
    const result = await runLearningPass(
      learnerOptions(storage, { llm: unavailable, fallbackLlm: fallback }),
    );
    expect(unavailable.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(1);
    expect(result).toMatchObject({ outcome: "changed", model: learningConfig.fallbackModelId });
    expect(learningConfig.learnerModelId).toBe("au.anthropic.claude-opus-4-6-v1");
  });

  it("reads each source at most once per refresh interval, and not again when nothing changed", async () => {
    const storage = new MemoryLearningStorage();
    const first = fetcher();
    const llm = new FakeLlm(() => record({}));
    await runLearningPass(learnerOptions(storage, { fetch: first, llm, run: quietRun() }));
    expect(first.calls).toHaveLength(learningConfig.sources.length);
    expect(llm.requests).toHaveLength(1);

    // The sources are cached and unchanged, and the run has nothing new: no fetch, no model call, no version.
    const second = fetcher();
    const quiet = await runLearningPass(
      learnerOptions(storage, { fetch: second, llm, run: quietRun() }),
    );
    expect(second.calls).toEqual([]);
    expect(llm.requests).toHaveLength(1);
    expect(quiet).toMatchObject({ outcome: "unchanged", version: null, cost: null });
    expect(await listVersions(storage, LIVE)).toEqual([1]);
    expect((await readStats(storage, LIVE)).value.runs).toBe(2);

    // A source that changed is read again, and the model is asked.
    const later = new Date(NOW.getTime() + 5 * 24 * 3600 * 1000);
    const third = fetcher({ revision: 2 });
    await runLearningPass(learnerOptions(storage, { fetch: third, llm, now: () => later }));
    expect(third.calls.length).toBeGreaterThan(0);
    expect(llm.requests).toHaveLength(2);
  });

  it("with a dry run, works out the change and writes nothing", async () => {
    const storage = new MemoryLearningStorage();
    await ensureSeed(storage, LIVE, NOW);
    const before = await everything(storage);
    const llm = new FakeLlm(() => record({ addItems: [itemProposal("k-dry-run-item")] }));
    const result = await runLearningPass(learnerOptions(storage, { llm, apply: false }));
    expect(result).toMatchObject({ outcome: "dry-run", version: 2 });
    expect(result.applied).toEqual(["added candidate k-dry-run-item"]);
    expect(await listVersions(storage, LIVE)).toEqual([1]);
    expect((await readStats(storage, LIVE)).value.runs).toBe(0);
    expect(await readLogs(storage, LIVE)).toEqual([]);
    expect(
      (await everything(storage)).replace(/learning\/(lock|sources)[^\n]*\n[^\n]*/g, ""),
    ).toContain("learning/current.json");
    expect(before).toContain("learning/versions/1.json");
  });
});

describe("what may never leave the run", () => {
  const planted = {
    host: "portal.acme-orders.com",
    username: "jane.doe@acme-orders.com",
    password: "Hunter2-Secret-Passw0rd",
    path: "/warehouse/consignments/884",
    words: "Acme wholesale warehouse manager for the northern depot",
  };
  const profile = {
    purpose: "Acme order portal for wholesale buyers of garden furniture",
    areas: [
      {
        name: "Consignments",
        description: "Where the northern depot tracks each consignment",
        path: planted.path,
        requiresLogin: true,
      },
    ],
    roles: [{ name: "Warehouse manager", description: planted.words, access: ["Consignments"] }],
    flows: [],
    technologies: ["GraphQL", "Express 4.17.1"],
    coverage: { pagesVisited: 4, loginsUsed: 1, signedIn: true },
  };
  const withSecrets = () =>
    runData({
      profile,
      pages: [planted.path, "/login"],
      input: {
        hosts: [planted.host],
        urls: [`https://${planted.host}/`],
        logins: [
          {
            username: planted.username,
            password: planted.password,
            description: planted.words,
            notes: "Only ever touches the northern depot consignments",
          },
        ],
        scopeNotes: "Please keep to the Acme staging copy of the order portal",
      },
    });

  it("never reaches the model: the digest holds no host, path, login or customer wording", async () => {
    const storage = new MemoryLearningStorage();
    const llm = new FakeLlm(() => record({}));
    await runLearningPass(learnerOptions(storage, { llm, run: withSecrets() }));
    expect(llm.requests.length).toBeGreaterThan(0);
    const sent = JSON.stringify(llm.requests).toLowerCase();
    for (const secret of [
      "acme",
      "hunter2",
      "jane.doe",
      "warehouse",
      "consignment",
      "northern depot",
      "/login",
      "garden furniture",
    ]) {
      expect(sent, secret).not.toContain(secret);
    }
    // What it does see is generic: the depth, check names, technologies from a fixed list, counts.
    expect(sent).toContain("graphql");
    expect(sent).toContain("express");
    expect(sent).toContain("4.17.1");
  });

  it("rejects every proposal that repeats the run, even when the model deliberately echoes it, and stores none of it", async () => {
    const echoes: LearningProposal[] = [
      {
        addItems: [
          itemProposal("k-echo-host", {
            description: `Introspection is on at ${planted.host} and exposes the schema.`,
          }),
        ],
      },
      { addAgents: [agentProposal("dyn-echo-path", planted.path)] },
      { addItems: [itemProposal("k-echo-user", { title: `${planted.username} can read orders` })] },
      {
        addItems: [
          itemProposal("k-echo-pass", {
            description: `The password ${planted.password} was accepted for sign-in.`,
          }),
        ],
      },
      {
        addItems: [
          itemProposal("k-echo-text", {
            description: "The Acme order portal for wholesale buyers leaks its schema to anyone.",
          }),
        ],
      },
    ].map((p) => p as unknown as LearningProposal);

    for (const proposal of echoes) {
      const storage = new MemoryLearningStorage();
      const logs: string[] = [];
      const spy = vi
        .spyOn(console, "error")
        .mockImplementation((m: unknown) => void logs.push(String(m)));
      try {
        const result = await runLearningPass(
          learnerOptions(storage, { llm: new FakeLlm(() => record(proposal)), run: withSecrets() }),
        );
        expect(result.outcome).toBe("unchanged");
        expect(result.rejected).toEqual([
          { what: "proposal", why: expect.stringMatching(/host|path|identifier|wording/) },
        ]);
        expect(result.proposal).toBeNull();
        expect(await listVersions(storage, LIVE)).toEqual([1]);
      } finally {
        spy.mockRestore();
      }
      // Nothing of the run is in a snapshot, the proposal log, the cached sources or the learner's own logs.
      const stored = (await everything(storage)).toLowerCase() + logs.join("\n").toLowerCase();
      for (const secret of [
        "acme-orders",
        "hunter2",
        "jane.doe",
        "consignments/884",
        "garden furniture",
      ]) {
        expect(stored, secret).not.toContain(secret);
      }
    }
  });

  it("builds the forbidden set from the run's host, paths, logins and wording", () => {
    const strings = runStringsOf(withSecrets());
    expect(strings.hosts).toContain(planted.host);
    expect(strings.paths).toContain(planted.path);
    expect(strings.identifiers).toEqual(
      expect.arrayContaining([planted.username, planted.password]),
    );
    expect(strings.texts.join(" ")).toContain("Acme order portal");
  });
});

describe("the review of a run", () => {
  /** The generic digest a learner is given, parsed back out of its prompt. */
  const digestOf = (
    request: LlmRequest,
  ): {
    signals: {
      uncoveredTechnology: string[];
      repeatedlyUnconfirmed: string[];
      neverFired: string[];
      closableGaps: unknown[];
    };
  } => {
    const first = request.messages[0]!.content[0] as { type: "text"; text: string };
    const found =
      /<untrusted-content source="scan-digest">\n([\s\S]*?)\n<\/untrusted-content>/.exec(
        first.text,
      );
    return JSON.parse(found![1]!);
  };

  it("turns an uncovered technology, a check that keeps going unconfirmed and a dynamic entry that never fires into a new item, a revision and a lowered score", async () => {
    const storage = new MemoryLearningStorage();
    await ensureSeed(storage, LIVE, NOW);
    // The layer already has one dynamic agent that has been observed in shadow twice without ever firing.
    const seeded = seedSnapshot(NOW);
    const idle = dynamicAgentSchema.parse({
      ...agentProposal("dyn-never-fires"),
      sourceId: undefined,
      source: {
        id: "owasp-top10",
        name: "OWASP Top 10",
        url: "https://top10.owasp.org/2025/",
        date: "2026-11-14",
      },
      status: "candidate",
      addedInVersion: 2,
    });
    await commitVersion(
      storage,
      LIVE,
      { ...seeded, version: 2, parent: 1, agents: [idle] },
      "test",
    );
    await updateStats(storage, LIVE, () => ({
      ...emptyStats(),
      runs: 4,
      checks: { "cors.origin": { runs: 1, unconfirmed: 1 } },
      agents: {
        "dyn-never-fires": {
          shadowRuns: 2,
          activeRuns: 0,
          fires: 0,
          errors: 0,
          outOfScope: 0,
          unconfirmed: 0,
          lastRun: 4,
          score: 1,
        },
      },
    }));

    // This run: GraphQL is in use and nothing covers it, cors.origin's finding is unconfirmed again, and
    // the idle agent ran its check once more and found nothing.
    const base = runData();
    const report = {
      ...base.report,
      findings: base.report.findings.map((f) =>
        f.agent === "cors" ? { ...f, verified: false, status: "unconfirmed" as const } : f,
      ),
    };
    const run: RunData = {
      ...base,
      report,
      results: {
        version: 2,
        items: [],
        agents: [
          {
            id: "dyn-never-fires",
            mode: "shadow",
            checks: 1,
            fired: 0,
            errors: 0,
            outOfScope: 0,
            unconfirmed: 0,
          },
        ],
        wouldRaise: [],
      },
    };

    const llm = new FakeLlm((request) => {
      // It reacts to what the digest signals, as a careful model would.
      const { signals } = digestOf(request);
      return record({
        addItems: signals.uncoveredTechnology.includes("graphql")
          ? [itemProposal("k-graphql-introspection")]
          : [],
        reviseItems: signals.repeatedlyUnconfirmed.includes("cors.origin")
          ? [
              {
                id: "k-owasp-misconfiguration",
                description:
                  "Missing headers and permissive cross-origin policy; confirm that the policy really reflects any origin before reporting it.",
              },
            ]
          : [],
        lowerScore: signals.neverFired.includes("dyn-never-fires")
          ? [{ id: "dyn-never-fires", reason: "never fires" }]
          : [],
      });
    });
    const result = await runLearningPass(
      learnerOptions(storage, { llm, run, config: config({ shadowRuns: 99 }) }),
    );

    expect(result.outcome).toBe("changed");
    expect(result.applied).toEqual([
      "added candidate k-graphql-introspection",
      "revised k-owasp-misconfiguration (back in shadow)",
      "lowered the score of dyn-never-fires",
    ]);
    const active = (await readActive(storage, LIVE, NOW))!;
    expect(active.snapshot.version).toBe(3);
    expect(active.snapshot.items.find((i) => i.id === "k-owasp-misconfiguration")!.status).toBe(
      "candidate",
    );
    expect(active.stats.agents["dyn-never-fires"]).toMatchObject({ shadowRuns: 3, score: 0.5 });
    expect(active.stats.checks["cors.origin"]).toEqual({ runs: 2, unconfirmed: 2 });
  });

  it("makes no new version for a run with nothing new, and does not even ask the model", async () => {
    const storage = new MemoryLearningStorage();
    const quiet = quietRun();
    const llm = new FakeLlm(() => record({}));
    await runLearningPass(learnerOptions(storage, { llm, run: quiet }));
    const calls = llm.requests.length;
    const result = await runLearningPass(learnerOptions(storage, { llm, run: quiet }));
    expect(llm.requests.length).toBe(calls);
    expect(result).toMatchObject({ outcome: "unchanged", version: null });
    expect(await listVersions(storage, LIVE)).toEqual([1]);
  });

  it("classifies gaps without keeping their wording", () => {
    expect(
      gapKind("The coverage limit for this scan depth was reached before this check could finish."),
    ).toBe("limit");
    expect(
      gapKind("The request budget for this scan depth was used up before this check could run."),
    ).toBe("limit");
    expect(gapKind("The target did not answer this check (timeout).")).toBe("no-answer");
    expect(gapKind("The scope guard refused a request this check needed (host not allowed).")).toBe(
      "scope-refused",
    );
    expect(gapKind("Something about portal.acme.example")).toBe("other");
  });
});

describe("the lifecycle across passes", () => {
  it("keeps a candidate in shadow, promotes it once it ran clean and the regression passed, and retires one that left the scope", async () => {
    const storage = new MemoryLearningStorage();
    await ensureSeed(storage, LIVE, NOW);
    const cfg = config({ shadowRuns: 2 });
    const shadow = (id: string, extra: Partial<{ outOfScope: number; fired: number }> = {}) => ({
      version: 2,
      items: [],
      agents: [
        {
          id,
          mode: "shadow" as const,
          checks: 1,
          fired: 0,
          errors: 0,
          outOfScope: 0,
          unconfirmed: 0,
          ...extra,
        },
      ],
      wouldRaise: [],
    });
    const propose = new FakeLlm(() =>
      record({
        addAgents: [agentProposal("dyn-debug-vars"), agentProposal("dyn-bad-check", "/other/vars")],
      }),
    );
    await runLearningPass(learnerOptions(storage, { llm: propose, config: cfg }));
    const quietLlm = new FakeLlm(() => record({}));
    const pass = (results: ReturnType<typeof shadow>) =>
      runLearningPass(
        learnerOptions(storage, {
          llm: quietLlm,
          config: cfg,
          run: runData({
            engagement: engagement({ hints: { routes: [], apiBases: [], ai: [] } }),
            results,
          }),
        }),
      );
    const statusOf = async (id: string) =>
      (await readActive(storage, LIVE, NOW))!.snapshot.agents.find((a) => a.id === id)!.status;

    await pass({
      ...shadow("dyn-debug-vars"),
      agents: [
        ...shadow("dyn-debug-vars").agents,
        ...shadow("dyn-bad-check", { outOfScope: 1 }).agents,
      ],
    });
    // The one that left the scope is gone at once; the other is still observing.
    expect(await statusOf("dyn-bad-check")).toBe("retired");
    expect(await statusOf("dyn-debug-vars")).toBe("candidate");

    await pass(shadow("dyn-debug-vars", { fired: 1 }));
    // Two clean shadow runs, but no passing regression yet.
    expect(await statusOf("dyn-debug-vars")).toBe("candidate");

    const version = (await readActive(storage, LIVE, NOW))!.snapshot.version;
    await updateStats(storage, LIVE, (s) => ({
      ...s,
      gate: {
        passed: true,
        version,
        runId: "run_gate0001",
        recordedAt: NOW.toISOString(),
        found: 19,
        expected: 19,
        stray: 0,
      },
    }));
    const promoted = await pass(shadow("dyn-debug-vars", { fired: 1 }));
    expect(promoted.lifecycle).toEqual(["promoted dyn-debug-vars to active"]);
    expect(await statusOf("dyn-debug-vars")).toBe("active");
    // The gate survives the pass that read it.
    expect((await readStats(storage, LIVE)).value.gate).toMatchObject({ passed: true });
  });

  it("refuses a second learner while one runs, and leaves the version alone when a pass times out", async () => {
    const storage = new MemoryLearningStorage();
    const slow = new FakeLlm(
      () => record({ addItems: [itemProposal("k-slow-item")] }),
      learningConfig.learnerModelId,
      300,
    );
    const first = runLearningPass(learnerOptions(storage, { llm: slow, holder: "first" }));
    await new Promise((r) => setTimeout(r, 30));
    const second = await runLearningPass(learnerOptions(storage, { holder: "second" }));
    expect(second).toMatchObject({ outcome: "skipped", note: "Another learning pass is running." });
    await first;
    expect((await readActive(storage, LIVE, NOW))!.snapshot.version).toBe(2);

    // A pass that runs out of time (its limit is in config) changes nothing and frees the lock.
    const stuck = new MemoryLearningStorage();
    const hang = new FakeLlm(
      () => record({ addItems: [itemProposal("k-never-lands")] }),
      learningConfig.learnerModelId,
      2000,
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const timed = await runLearningPass(
        learnerOptions(stuck, { llm: hang, config: config({}, { timeoutSeconds: 0.2 }) }),
      );
      expect(timed.outcome).toBe("failed");
      expect(timed.note).toMatch(/ran out of time/);
    } finally {
      spy.mockRestore();
    }
    expect(await listVersions(stuck, LIVE)).toEqual([1]);
    const after = await runLearningPass(
      learnerOptions(stuck, { llm: new FakeLlm(() => record({})) }),
    );
    expect(after.outcome).not.toBe("skipped");
  });

  it("does nothing while the kill switch is on, and the rolled-back version is what a new pass builds on", async () => {
    const storage = new MemoryLearningStorage();
    await runLearningPass(
      learnerOptions(storage, {
        llm: new FakeLlm(() => record({ addItems: [itemProposal("k-first-add")] })),
      }),
    );
    await setPointer(storage, LIVE, { version: 1, by: "staff", now: NOW });
    const rolled = await runLearningPass(
      learnerOptions(storage, {
        llm: new FakeLlm(() => record({ addItems: [itemProposal("k-after-rollback")] })),
        run: null,
        force: true,
      }),
    );
    // The new version is numbered after the latest one, and descends from the version rolled back to.
    expect(rolled.version).toBe(3);
    const active = (await readActive(storage, LIVE, NOW))!;
    expect(active.snapshot).toMatchObject({ version: 3, parent: 1 });
    expect(active.snapshot.items.map((i) => i.id)).toContain("k-after-rollback");
    expect(active.snapshot.items.map((i) => i.id)).not.toContain("k-first-add");

    await setPointer(storage, LIVE, { enabled: false, by: "staff", now: NOW });
    const llm = new FakeLlm(() => record({}));
    const off = await runLearningPass(learnerOptions(storage, { llm }));
    expect(off.outcome).toBe("skipped");
    expect(llm.requests).toEqual([]);
  });
});

// The sources -----------------------------------------------------------------------------------

describe("the sources", () => {
  it("reduces a page to its text and the KEV catalogue to its newest lines", () => {
    expect(
      htmlToText(
        "<html><script>x()</script><style>a{}</style><p>Hello &amp; <b>world</b></p></html>",
      ),
    ).toBe("Hello & world");
    expect(kevToText(KEV).split("\n")[0]).toContain("CVE-2025-0002");
  });

  it("refuses a source that answers with the wrong type, is too big, or sends us elsewhere; one bad source never stops the rest", async () => {
    const storage = new MemoryLearningStorage();
    const bad: FetchLike = async (url) => {
      if (url.includes("top10.owasp.org")) {
        return served("<html>x</html>", "application/octet-stream", url);
      }
      if (url.includes("genai.owasp.org")) {
        return served("<html>ok</html>", "text/html", "https://evil.example/llm");
      }
      if (url.includes("known_exploited")) {
        return served("x".repeat(4_000_000), "application/json", url);
      }
      return served("<p>fine</p>", "text/html", url);
    };
    const { sources, problems } = await loadSources({ storage, root: LIVE, fetch: bad, now: NOW });
    expect(sources.map((s) => s.id)).toEqual(["owasp-cheatsheets"]);
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toMatch(/content type/);
    expect(problems.join("\n")).toMatch(/listed hosts/);
    expect(problems.join("\n")).toMatch(/larger than its limit/);
  });

  it("falls back to the cache when a source cannot be fetched", async () => {
    const storage = new MemoryLearningStorage();
    await loadSources({ storage, root: LIVE, fetch: fetcher(), now: NOW });
    const later = new Date(NOW.getTime() + 10 * 24 * 3600 * 1000);
    const down = fetcher({ fail: new Set(learningConfig.sources.map((s) => s.url)) });
    const { sources, problems } = await loadSources({
      storage,
      root: LIVE,
      fetch: down,
      now: later,
    });
    expect(sources).toHaveLength(learningConfig.sources.length);
    expect(sources.every((s) => !s.fresh)).toBe(true);
    expect(problems).toHaveLength(learningConfig.sources.length);
  });
});

// The dynamic agent runtime -----------------------------------------------------------------------

describe("a dynamic agent's checks", () => {
  const response = (status: number, headers: Record<string, string>, body: string): HttpResult => ({
    url: "http://t.test/",
    status,
    headers,
    body,
    redirects: [],
    tls: null,
  });

  const ctxFor = (
    routes: Record<string, HttpResult>,
    options: { blocked?: string[]; scripts?: Record<string, string>; inline?: string[] } = {},
  ) => {
    const seen: string[] = [];
    const ctx = {
      appUrl: new URL("http://t.test/"),
      http: {
        request: async ({ url, method }: { url: string; method?: string }) => {
          const path = new URL(url).pathname;
          seen.push(`${method ?? "GET"} ${path}`);
          if (options.blocked?.includes(path)) throw new RequestFailed("host_not_allowed", true);
          return routes[path] ?? response(404, {}, "");
        },
      },
      pageScripts: async () => ({
        external: Object.keys(options.scripts ?? {}),
        inline: options.inline ?? [],
      }),
      scriptBody: async (url: string) => options.scripts?.[url] ?? null,
      shared: new Map(),
    } as unknown as StepContext;
    return { ctx, seen };
  };

  const candidate = (checks: DynamicAgent["checks"], id = "dyn-test-agent"): DynamicAgent =>
    dynamicAgentSchema.parse({
      id,
      title: "Test agent",
      objective: "An agent for the tests of the runtime.",
      area: "unauth",
      appliesTo: ["any"],
      source: {
        id: "owasp-top10",
        name: "OWASP Top 10",
        url: "https://top10.owasp.org/2025/",
        date: "2026-11-14",
      },
      status: "active",
      addedInVersion: 2,
      checks,
    });
  const finding = {
    title: "Something is exposed to anyone",
    severity: "medium" as const,
    description: "A generic description of what is exposed and why it matters to the operator.",
    remediation: "Remove it or restrict it to the people who need it.",
  };
  const probe = {
    kind: "probe" as const,
    id: "vars",
    label: "Variables",
    method: "GET" as const,
    paths: ["/debug/vars", "/vars"],
    match: { bodyIncludes: ["memstats"] },
    finding,
  };
  const runtime = (agent: DynamicAgent, mode: "active" | "shadow" = "active") =>
    new DynamicRuntime(2, [], [{ agent, mode }]);

  it("matches a response by status, headers and body, all at once, and never on a status alone", () => {
    const res = response(200, { "x-powered-by": "Express" }, "<html>MemStats here</html>");
    expect(matches(res, { status: [200], bodyIncludes: ["memstats"] })).toBe(true);
    expect(matches(res, { status: [404], bodyIncludes: ["memstats"] })).toBe(false);
    expect(matches(res, { headerIncludes: [{ name: "x-powered-by", value: "express" }] })).toBe(
      true,
    );
    expect(matches(res, { headerPresent: ["x-missing"] })).toBe(false);
    expect(matches(res, { bodyIncludes: ["memstats", "cmdline"] })).toBe(false);
  });

  it("a probe sends only the safe request it names, and raises the generic finding with a verifiable component", async () => {
    const rt = runtime(candidate([probe]));
    const { ctx, seen } = ctxFor({ "/debug/vars": response(200, {}, '{"memstats":{}}') });
    const result = await rt.active()[0]!.module.steps["vars"]!(ctx);
    expect(seen).toEqual(["GET /debug/vars"]);
    expect(result).toMatchObject({
      outcome: "finding",
      finding: { title: finding.title, component: "GET /debug/vars", severity: "medium" },
    });
    expect(rt.counters.get("dyn-test-agent")).toMatchObject({
      checks: 1,
      fired: 1,
      errors: 0,
      outOfScope: 0,
    });
  });

  it("a probe that finds nothing is clear; a request the scope guard refuses is counted, never retried elsewhere", async () => {
    const rt = runtime(candidate([probe]));
    const clear = await rt.active()[0]!.module.steps["vars"]!(ctxFor({}).ctx);
    expect(clear.outcome).toBe("clear");
    const { ctx, seen } = ctxFor({}, { blocked: ["/debug/vars", "/vars"] });
    expect((await rt.active()[0]!.module.steps["vars"]!(ctx)).outcome).toBe("clear");
    expect(seen).toEqual(["GET /debug/vars", "GET /vars"]);
    expect(rt.counters.get("dyn-test-agent")!.outOfScope).toBe(2);
  });

  it("header and script checks look only at what the application serves", async () => {
    const agent = candidate([
      {
        kind: "header",
        id: "csp",
        label: "CSP",
        path: "/",
        header: "content-security-policy",
        raiseWhen: "absent",
        finding,
      },
      {
        kind: "header",
        id: "framing",
        label: "Framing",
        path: "/",
        header: "x-frame-options",
        raiseWhen: "excludes",
        value: "deny",
        finding,
      },
      { kind: "scripts", id: "keys", label: "Keys", includes: ["sk_live_"], finding },
    ]);
    const rt = runtime(agent);
    const steps = rt.active()[0]!.module.steps;
    const page = response(200, { "x-frame-options": "SAMEORIGIN" }, "");
    const ctx = ctxFor(
      { "/": page },
      { scripts: { "http://t.test/app.js": "var k='sk_live_123'" } },
    ).ctx;
    expect((await steps["csp"]!(ctx)).outcome).toBe("finding");
    expect((await steps["framing"]!(ctx)).outcome).toBe("finding");
    expect((await steps["keys"]!(ctx)).outcome).toBe("finding");
    const protectedPage = response(
      200,
      { "content-security-policy": "default-src 'self'", "x-frame-options": "DENY" },
      "",
    );
    const calm = ctxFor({ "/": protectedPage }).ctx;
    expect((await steps["csp"]!(calm)).outcome).toBe("clear");
    expect((await steps["framing"]!(calm)).outcome).toBe("clear");
    expect((await steps["keys"]!(calm)).outcome).toBe("clear");
  });

  it("a candidate observes in shadow: what it would raise is recorded, and nothing else", async () => {
    const rt = runtime(candidate([probe]), "shadow");
    expect(rt.active()).toEqual([]);
    const { ctx } = ctxFor({ "/debug/vars": response(200, {}, '{"memstats":{}}') });
    let steps = 0;
    await rt.runShadow(ctx, { useStep: () => void (steps += 1) });
    expect(steps).toBe(1);
    const results = rt.results()!;
    expect(results.agents[0]).toMatchObject({
      id: "dyn-test-agent",
      mode: "shadow",
      checks: 1,
      fired: 1,
    });
    expect(results.wouldRaise).toEqual([
      {
        agent: "dyn-test-agent",
        check: "vars",
        title: finding.title,
        component: "GET /debug/vars",
      },
    ]);
  });

  it("re-tests by running the check again with counters nobody reads", async () => {
    const rt = runtime(candidate([probe]));
    const again = rt.verifierModules()["dyn-test-agent"]!;
    await again.steps["vars"]!(ctxFor({ "/debug/vars": response(200, {}, "memstats") }).ctx);
    expect(rt.counters.get("dyn-test-agent")).toMatchObject({ checks: 0, fired: 0 });
  });

  it("has a spec like any roster agent: its area's colour, a step per check", () => {
    const rt = runtime(candidate([probe]));
    const { spec } = rt.active()[0]!;
    expect(spec).toMatchObject({
      id: "dyn-test-agent",
      area: "unauth",
      colour: "#a3e635",
      steps: [{ id: "vars", label: "Variables" }],
    });
  });

  it("uses the entries the plan selected, and reports a version only when a layer was in use", () => {
    const layer = pinLayer(seedSnapshot(NOW), emptyStats());
    const picked = selectDynamic(layer, tokensOf([], ["any"]), "probe");
    expect(new DynamicRuntime(null, picked.items, picked.agents).results()).toBeNull();
    const results = new DynamicRuntime(1, picked.items, picked.agents).results()!;
    expect(results.items.every((i) => i.mode === "active")).toBe(true);
    expect(results.agents).toEqual([]);
  });
});
