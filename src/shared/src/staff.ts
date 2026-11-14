import type { Frequency, RunTrigger } from "./scans.js";
import type { RunStatus, Severity, TierId } from "./events.js";

/**
 * The staff dashboard's wire types (PLAN.md section 12). Types only, plus the pricing worksheet's
 * arithmetic. These carry dollars and caps, so they are staff-only: the API serves them behind the
 * server-side staff check, and the browser loads the staff screens as their own chunk.
 */

/** Who paid for a run. `credit` is a customer run from before the credit's source was recorded. */
export type EntitlementSource = "staff" | "comp" | "purchase" | "credit";

export interface StaffRunRow {
  runId: string;
  tier: TierId;
  trigger: RunTrigger;
  entitlement: EntitlementSource;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationSeconds: number;
  findings: number;
  /** The run's estimated cost, with its learning pass. Null while the run is still going. */
  costUsd: number | null;
  /** Still going (queued or running): read from the account, not the anonymised index. */
  live: boolean;
  test: boolean;
}

export interface StaffRunsResponse {
  rows: StaffRunRow[];
  from: string;
  to: string;
  /** More runs matched than were returned. */
  truncated: boolean;
}

/** One run for the detail view: its data while the account has it, and its anonymised index row. */
export interface StaffRunDetailResponse {
  /** Null once the run or its account was deleted: only the anonymised row remains. */
  detail: StaffRunDetail | null;
  row: StaffRunRow | null;
}

export interface StaffAgentActivity {
  agent: string;
  name: string;
  steps: number;
  requests: number;
  findings: number;
  gaps: number;
  done: boolean;
}

export interface StaffRunDetail {
  runId: string;
  /** The account, for the Users view; staff may see it, it is not the email. */
  accountHash: string;
  tier: TierId;
  status: RunStatus;
  trigger: RunTrigger;
  entitlement: EntitlementSource;
  test: boolean;
  target: string;
  startedAt: string;
  finishedAt: string | null;
  durationSeconds: number;
  reason: string | null;
  summary: {
    checks: number;
    requests: number;
    coverage: number;
    gaps: number;
    findings: { total: number; verified: number; bySeverity: Record<Severity, number> };
    agents: { total: number; done: number };
  };
  /** The recorded cost (`cost.json`) as it was priced; null until the run has closed. */
  cost: StaffRunCost | null;
  /** What the run used against what the depth allowed. Null when the run has no cost record yet. */
  budgets: StaffBudgetLine[];
  agents: StaffAgentActivity[];
  gaps: { agent: string | null; reason: string }[];
  events: { seq: number; ts: string; type: string; agent: string | null; text: string }[];
  eventCount: number;
  reportReady: boolean;
  instructionsVersion: string | null;
  dynamicVersion: number | null;
}

export interface StaffBudgetLine {
  name: string;
  used: number;
  cap: number | null;
  unit: string;
}

export interface StaffRunCost {
  pricingVersion: string;
  pricingVerified: boolean;
  totalUsd: number;
  fargate: { usd: number; taskSeconds: number };
  egress: { usd: number; bytesOut: number };
  bedrock: {
    usd: number;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    modelId: string | null;
  };
  orchestration: { usd: number };
  learner: {
    usd: number;
    seconds: number;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    modelId: string;
  } | null;
}

export interface TierCostStats {
  runs: number;
  avgUsd: number;
  medianUsd: number;
  p95Usd: number;
  maxUsd: number;
  totalUsd: number;
  avgDurationSeconds: number;
  findings: number;
  /** Total cost over total findings; null when the runs found nothing. */
  costPerFindingUsd: number | null;
}

export interface CostAnalysis {
  from: string;
  to: string;
  /** The price table the figures use: each run as recorded, or every run costed again under this version. */
  pricing: { mode: "recorded" | "repriced"; version: string | null };
  runs: number;
  /** Runs kept as recorded in a re-priced view, because they predate the usage record or use an unlisted model. */
  notRepriced: number;
  totalUsd: number;
  byTier: Record<TierId, TierCostStats>;
  byDay: { day: string; runs: number; usd: number }[];
  bySource: Record<EntitlementSource, { runs: number; usd: number }>;
  components: {
    fargateUsd: number;
    egressUsd: number;
    bedrockUsd: number;
    orchestrationUsd: number;
    learnerUsd: number;
  };
  /** The most expensive runs, for tuning the caps. */
  topRuns: { runId: string; tier: TierId; costUsd: number; startedAt: string }[];
}

/** Runs per year of a repeating cadence, for the annualised cost of a recurring scan. */
export const RUNS_PER_YEAR: Record<Exclude<Frequency, "once">, number> = {
  daily: 365,
  weekly: 52,
  monthly: 12,
  yearly: 1,
};

/** A price from a measured cost: the cost plus a margin (0.5 is 50%), never below the floor. */
export function suggestPrice(costUsd: number, margin: number, floorUsd = 0): number {
  return Math.max(floorUsd, Math.ceil(costUsd * (1 + margin) * 100) / 100);
}

export interface StaffTierCaps {
  pageCap: number | null;
  llmStepCap: number | null;
  stepCap: number;
  requestCap: number;
  requestsPerSecond: number;
  tokenCap: { input: number; output: number } | null;
  spendCapUsd: number;
}

export interface StaffControls {
  killSwitch: { on: boolean; reason: string; at: number | null; by: string | null };
  concurrency: Record<TierId, number>;
  caps: Record<TierId, StaffTierCaps>;
  dailySpendAlarmUsd: number | null;
  scheduledScans: { maxActivePerAccount: number; minSpacingHours: number };
  blockedHosts: string[];
  blockedEmailDomains: string[];
  /** What the code ships with, for "reset" and for the placeholder next to each field. */
  defaults: {
    concurrency: Record<TierId, number>;
    caps: Record<TierId, StaffTierCaps>;
    dailySpendAlarmUsd: number | null;
    scheduledScans: { maxActivePerAccount: number; minSpacingHours: number };
  };
  updatedAt: number | null;
  updatedBy: string | null;
}

export interface StaffAuditRecord {
  at: string;
  action: string;
  by: string;
  detail: Record<string, unknown>;
}

export interface StaffPriceTable {
  version: string;
  verified: boolean;
  currency: "USD";
  fargate: { vcpuPerHour: number; gbPerHour: number };
  egressPerGb: number;
  stepFunctionsPerTransition: number;
  bedrock: Record<string, { inputPerMTok: number; outputPerMTok: number }>;
}

export interface StaffPricing {
  active: StaffPriceTable;
  versions: {
    version: string;
    savedAt: number | null;
    by: string;
    note: string;
    verified: boolean;
    shipped: boolean;
  }[];
}

export interface StaffAccountScan {
  id: string;
  name: string;
  tier: TierId;
  frequency: Frequency;
  status: "active" | "paused";
  notifyOn: string;
  notifyConfirmed: boolean;
  target: string;
}

export interface StaffAccount {
  accountHash: string;
  email: string;
  role: "customer" | "staff";
  test: boolean;
  createdAt: number;
  lastLoginAt: number;
  credits: Record<TierId, number>;
  ledger: {
    granted: { comp: Record<TierId, number>; purchase: Record<TierId, number> };
    consumed: Record<TierId, number>;
    grants: {
      at: number;
      source: "comp" | "purchase";
      tier: TierId;
      count: number;
      reason: string;
      by: string;
    }[];
  };
  targets: number;
  scans: StaffAccountScan[];
  runs: {
    runId: string;
    tier: TierId;
    status: RunStatus;
    startedAt: string;
    trigger: RunTrigger;
    entitlement: EntitlementSource;
  }[];
}

export interface StaffHealth {
  at: string;
  killSwitchOn: boolean;
  spendToday: { day: string; usd: number; runs: number; alarmUsd: number | null; alarmed: boolean };
  /** Runs holding or waiting for a slot, per depth. */
  pools: Record<TierId, { active: number; waiting: number; limit: number }>;
  /** Queued or running runs that should have finished by now. */
  stuckRuns: {
    runId: string;
    tier: TierId;
    status: RunStatus;
    startedAt: string;
    ageMinutes: number;
  }[];
  /** From CloudWatch, last 24 hours; null when it could not be read. */
  ses: {
    sends: number;
    bounces: number;
    complaints: number;
    bounceRate: number;
    complaintRate: number;
    /** Account-level reputation rates SES itself reports (null when absent). */
    reputationBounceRate: number | null;
    reputationComplaintRate: number | null;
  } | null;
  bedrock: { throttles: number; modelIds: string[] } | null;
  /** Mailboxes suppressed after a bounce or complaint. */
  suppressed: number;
}

export interface StaffLearning {
  enabled: boolean;
  /** The kill switch is on: runs use the baseline only. */
  killSwitchOn: boolean;
  version: number | null;
  versions: {
    version: number;
    createdAt: string;
    parent: number | null;
    reason: string;
    items: number;
    agents: number;
  }[];
  items: StaffLayerEntry[];
  agents: StaffLayerEntry[];
  recent: { at: string; outcome: string; toVersion: number | null; model: string | null }[];
}

export interface StaffLayerEntry {
  id: string;
  title: string;
  status: "candidate" | "active" | "retired";
  pinned: boolean;
  disabled: boolean;
  source: string;
}
