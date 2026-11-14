import {
  TIER_IDS,
  type CostAnalysis,
  type StaffAccount,
  type StaffControls,
  type StaffHealth,
  type StaffLearning,
  type StaffPricing,
  type StaffRunDetail,
  type StaffRunRow,
  type TierCostStats,
  type TierId,
} from "@swarm/shared";
import type { StaffApi } from "./staff.js";

const perTier = <T>(make: (tier: TierId) => T) =>
  Object.fromEntries(TIER_IDS.map((t) => [t, make(t)])) as Record<TierId, T>;

export const MOCK_STAFF_RUNS: StaffRunRow[] = [
  {
    runId: "run_0mock0000001aaaaaaaaa",
    tier: "sweep",
    trigger: "manual",
    entitlement: "comp",
    status: "complete",
    startedAt: "2026-11-10T01:00:00.000Z",
    finishedAt: "2026-11-10T01:12:00.000Z",
    durationSeconds: 720,
    findings: 4,
    costUsd: 0.62,
    live: false,
    test: false,
  },
  {
    runId: "run_0mock0000002aaaaaaaaa",
    tier: "siege",
    trigger: "manual",
    entitlement: "staff",
    status: "running",
    startedAt: "2026-11-10T02:00:00.000Z",
    finishedAt: null,
    durationSeconds: 300,
    findings: 1,
    costUsd: null,
    live: true,
    test: false,
  },
];

const stats = (tier: TierId): TierCostStats =>
  tier === "sweep"
    ? {
        runs: 4,
        avgUsd: 0.6,
        medianUsd: 0.55,
        p95Usd: 0.9,
        maxUsd: 0.9,
        totalUsd: 2.4,
        avgDurationSeconds: 700,
        findings: 12,
        costPerFindingUsd: 0.2,
      }
    : {
        runs: 0,
        avgUsd: 0,
        medianUsd: 0,
        p95Usd: 0,
        maxUsd: 0,
        totalUsd: 0,
        avgDurationSeconds: 0,
        findings: 0,
        costPerFindingUsd: null,
      };

export const MOCK_COSTS: CostAnalysis = {
  from: "2026-10-15",
  to: "2026-11-14",
  pricing: { mode: "recorded", version: null },
  runs: 4,
  notRepriced: 0,
  totalUsd: 2.4,
  byTier: perTier(stats),
  byDay: [{ day: "2026-11-10", runs: 4, usd: 2.4 }],
  bySource: {
    staff: { runs: 1, usd: 0.5 },
    comp: { runs: 3, usd: 1.9 },
    purchase: { runs: 0, usd: 0 },
    credit: { runs: 0, usd: 0 },
  },
  components: {
    fargateUsd: 0.1,
    egressUsd: 0.1,
    bedrockUsd: 2,
    orchestrationUsd: 0,
    learnerUsd: 0.2,
  },
  topRuns: [
    {
      runId: "run_0mock0000001aaaaaaaaa",
      tier: "sweep",
      costUsd: 0.9,
      startedAt: "2026-11-10T01:00:00.000Z",
    },
  ],
};

export const MOCK_PRICING: StaffPricing = {
  active: {
    version: "2026-11-14",
    verified: false,
    currency: "USD",
    fargate: { vcpuPerHour: 0.0506, gbPerHour: 0.0056 },
    egressPerGb: 0.114,
    stepFunctionsPerTransition: 0.000025,
    bedrock: {
      "au.anthropic.claude-haiku-4-5-20251001-v1:0": { inputPerMTok: 1, outputPerMTok: 5 },
    },
  },
  versions: [
    {
      version: "2026-11-14",
      savedAt: null,
      by: "pricing.json",
      note: "The table shipped with the code.",
      verified: false,
      shipped: true,
    },
  ],
};

const caps = (spendCapUsd: number) => ({
  pageCap: 40,
  llmStepCap: 60,
  stepCap: 40,
  requestCap: 300,
  requestsPerSecond: 2,
  tokenCap: { input: 600000, output: 30000 },
  spendCapUsd,
});

export const MOCK_CONTROLS: StaffControls = {
  killSwitch: { on: false, reason: "", at: null, by: null },
  concurrency: { scout: 4, sweep: 3, probe: 2, siege: 2 },
  caps: { scout: caps(1), sweep: caps(3), probe: caps(8), siege: caps(15) },
  dailySpendAlarmUsd: 25,
  scheduledScans: { maxActivePerAccount: 5, minSpacingHours: 24 },
  blockedHosts: [],
  blockedEmailDomains: [],
  defaults: {
    concurrency: { scout: 4, sweep: 3, probe: 2, siege: 2 },
    caps: { scout: caps(1), sweep: caps(3), probe: caps(8), siege: caps(15) },
    dailySpendAlarmUsd: 25,
    scheduledScans: { maxActivePerAccount: 5, minSpacingHours: 24 },
  },
  updatedAt: null,
  updatedBy: null,
};

export const MOCK_HEALTH: StaffHealth = {
  at: "2026-11-14T00:00:00.000Z",
  killSwitchOn: false,
  spendToday: { day: "2026-11-14", usd: 1.25, runs: 2, alarmUsd: 25, alarmed: false },
  pools: perTier((t) => ({ active: t === "siege" ? 1 : 0, waiting: 0, limit: 2 })),
  stuckRuns: [],
  ses: {
    sends: 100,
    bounces: 1,
    complaints: 0,
    bounceRate: 0.01,
    complaintRate: 0,
    reputationBounceRate: 0.01,
    reputationComplaintRate: 0,
  },
  bedrock: { throttles: 3, modelIds: ["au.anthropic.claude-haiku-4-5-20251001-v1:0"] },
  suppressed: 0,
};

export const MOCK_LEARNING: StaffLearning = {
  enabled: true,
  killSwitchOn: false,
  version: 2,
  versions: [
    {
      version: 2,
      createdAt: "2026-11-14T00:00:00.000Z",
      parent: 1,
      reason: "a learning pass",
      items: 9,
      agents: 1,
    },
    {
      version: 1,
      createdAt: "2026-11-13T00:00:00.000Z",
      parent: null,
      reason: "seed",
      items: 8,
      agents: 0,
    },
  ],
  items: [
    {
      id: "k-owasp-a01",
      title: "Broken access control",
      status: "active",
      pinned: false,
      disabled: false,
      source: "OWASP Top 10:2025",
    },
  ],
  agents: [
    {
      id: "dyn-sourcemap",
      title: "Source maps",
      status: "candidate",
      pinned: false,
      disabled: false,
      source: "OWASP",
    },
  ],
  recent: [{ at: "2026-11-14T00:00:00.000Z", outcome: "applied", toVersion: 2, model: "opus" }],
};

export const MOCK_ACCOUNT: StaffAccount = {
  accountHash: "a".repeat(64),
  email: "buyer@example.com",
  role: "customer",
  test: false,
  createdAt: 1_700_000_000_000,
  lastLoginAt: 1_700_000_100_000,
  credits: { scout: 1, sweep: 2, probe: 0, siege: 0 },
  ledger: {
    granted: {
      comp: { scout: 1, sweep: 3, probe: 0, siege: 0 },
      purchase: { scout: 0, sweep: 0, probe: 0, siege: 0 },
    },
    consumed: { scout: 0, sweep: 1, probe: 0, siege: 0 },
    grants: [
      {
        at: 1_700_000_000_000,
        source: "comp",
        tier: "sweep",
        count: 3,
        reason: "beta tester",
        by: "ops@fhlostonswarm.com",
      },
    ],
  },
  targets: 1,
  scans: [
    {
      id: "scan_0mock0000001aaaa",
      name: "Staging",
      tier: "sweep",
      frequency: "weekly",
      status: "active",
      notifyOn: "always",
      notifyConfirmed: true,
      target: "staging.example.com",
    },
  ],
  runs: [
    {
      runId: "run_0mock0000001aaaaaaaaa",
      tier: "sweep",
      status: "complete",
      startedAt: "2026-11-10T01:00:00.000Z",
      trigger: "manual",
      entitlement: "comp",
    },
  ],
};

const detail = (runId: string): StaffRunDetail => ({
  runId,
  accountHash: MOCK_ACCOUNT.accountHash,
  tier: "sweep",
  status: "complete",
  trigger: "manual",
  entitlement: "comp",
  test: false,
  target: "staging.example.com",
  startedAt: "2026-11-10T01:00:00.000Z",
  finishedAt: "2026-11-10T01:12:00.000Z",
  durationSeconds: 720,
  reason: null,
  summary: {
    checks: 30,
    requests: 200,
    coverage: 0.9,
    gaps: 1,
    findings: {
      total: 4,
      verified: 3,
      bySeverity: { critical: 0, high: 1, medium: 2, low: 1, info: 0 },
    },
    agents: { total: 6, done: 6 },
  },
  cost: {
    pricingVersion: "2026-11-14",
    pricingVerified: false,
    totalUsd: 0.62,
    fargate: { usd: 0.01, taskSeconds: 700 },
    egress: { usd: 0.01, bytesOut: 1_000_000 },
    bedrock: {
      usd: 0.55,
      calls: 30,
      inputTokens: 400_000,
      outputTokens: 20_000,
      modelId: "au.anthropic.claude-haiku-4-5-20251001-v1:0",
    },
    orchestration: { usd: 0 },
    learner: null,
  },
  budgets: [
    { name: "Checks", used: 30, cap: 80, unit: "checks" },
    { name: "Model spend", used: 0.55, cap: 3, unit: "USD" },
  ],
  agents: [{ agent: "tls", name: "TLS", steps: 3, requests: 12, findings: 0, gaps: 0, done: true }],
  gaps: [{ agent: "authn", reason: "No login supplied" }],
  events: [
    {
      seq: 1,
      ts: "2026-11-10T01:00:01.000Z",
      type: "dispatch",
      agent: "tls",
      text: "Check transport",
    },
  ],
  eventCount: 1,
  reportReady: true,
  instructionsVersion: "2026-11-11",
  dynamicVersion: 2,
});

/** No network: fixed data for the staff screens, with the controls and kill switch remembered while the page is open. */
export function createMockStaffApi(): StaffApi {
  let controls: StaffControls = structuredClone(MOCK_CONTROLS);
  let learning: StaffLearning = structuredClone(MOCK_LEARNING);
  return {
    runs: async () => ({
      rows: MOCK_STAFF_RUNS,
      from: "2026-10-15",
      to: "2026-11-14",
      truncated: false,
    }),
    run: async (runId) => ({ detail: detail(runId), row: null }),
    stopRun: async () => undefined,
    deleteRun: async () => undefined,
    resendRunEmail: async () => undefined,
    costs: async () => MOCK_COSTS,
    previewCosts: async (table) => ({
      ...MOCK_COSTS,
      pricing: { mode: "repriced", version: table.version },
    }),
    pricing: async () => MOCK_PRICING,
    savePricing: async () => MOCK_PRICING,
    account: async () => MOCK_ACCOUNT,
    grantCredit: async () => undefined,
    setScanStatus: async () => undefined,
    deleteAccount: async () => undefined,
    controls: async () => controls,
    saveControls: async (patch) => {
      controls = {
        ...controls,
        ...(patch.concurrency
          ? { concurrency: { ...controls.concurrency, ...patch.concurrency } }
          : {}),
        ...(patch.dailySpendAlarmUsd !== undefined
          ? { dailySpendAlarmUsd: patch.dailySpendAlarmUsd }
          : {}),
        ...(patch.scheduledScans ? { scheduledScans: patch.scheduledScans } : {}),
        ...(patch.blockedHosts ? { blockedHosts: patch.blockedHosts } : {}),
        ...(patch.blockedEmailDomains ? { blockedEmailDomains: patch.blockedEmailDomains } : {}),
      };
      return controls;
    },
    setKillSwitch: async (on, reason) => {
      controls = { ...controls, killSwitch: { on, reason, at: Date.now(), by: "staff" } };
      return { controls, stopped: on ? 1 : 0 };
    },
    audit: async () => [
      {
        at: "2026-11-14T00:00:00.000Z",
        action: "set-controls",
        by: "ops@fhlostonswarm.com",
        detail: { changed: ["dailySpendAlarmUsd"] },
      },
    ],
    health: async () => MOCK_HEALTH,
    learning: async () => learning,
    rollbackLearning: async (version) => (learning = { ...learning, version }),
    setLearningEnabled: async (enabled) => (learning = { ...learning, killSwitchOn: !enabled }),
    setLearningEntry: async (entry) => {
      const patch = (e: StaffLearning["items"][number]) =>
        e.id === entry.id
          ? {
              ...e,
              ...(entry.pinned !== undefined ? { pinned: entry.pinned } : {}),
              ...(entry.disabled !== undefined ? { disabled: entry.disabled } : {}),
            }
          : e;
      learning = {
        ...learning,
        items: learning.items.map(patch),
        agents: learning.agents.map(patch),
      };
      return learning;
    },
  };
}
