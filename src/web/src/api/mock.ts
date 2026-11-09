import {
  AGENTS,
  AREAS,
  DEMO_RUN_ID,
  DEMO_TARGET,
  applyEvents,
  createRunState,
  replayEvents,
  summarise,
  type RunListItem,
  type ScanSummary,
  type Summary,
  type TargetView,
  type TierId,
} from "@swarm/shared";

export interface AccountInfo {
  /** Credits held per tier. Every run consumes a paid or granted credit. */
  credits: Record<TierId, number>;
  /** Staff may start runs without a credit. */
  unmetered: boolean;
}

const demoSummary = (): Summary =>
  summarise(
    applyEvents(
      createRunState({ runId: DEMO_RUN_ID, tier: "siege", areas: AREAS, agents: AGENTS }),
      replayEvents,
    ),
  );

const scoutSummary: Summary = {
  runId: "run_scout0001",
  status: "complete",
  tier: "scout",
  startedAt: "2026-11-09T02:00:00.000Z",
  finishedAt: "2026-11-09T02:04:12.000Z",
  durationMs: 252_000,
  checks: 14,
  requests: 96,
  coverage: 1,
  findings: {
    total: 3,
    verified: 0,
    bySeverity: { critical: 0, high: 0, medium: 1, low: 2, info: 0 },
  },
  gaps: 0,
  agents: { total: 4, done: 4 },
};

/** Fixed rows for component tests and offline review; the real app reads them from the API. */
export const MOCK_RUNS: RunListItem[] = [
  { summary: demoSummary(), target: DEMO_TARGET, scanId: "scan_monthly01", trigger: "manual" },
  {
    summary: scoutSummary,
    target: "staging.example-shop.test",
    scanId: "scan_daily001",
    trigger: "manual",
  },
];

const STAGING = "staging.example-shop.test";

/**
 * Three scans on one application, as a customer might set them up: a quick daily, a medium weekly
 * and a deep monthly, plus a one-off deep report. All are saved, so each can be run again.
 */
export const MOCK_SCANS: ScanSummary[] = [
  {
    id: "scan_daily001",
    targetId: "tgt_staging01",
    timezone: "Australia/Sydney",
    loginSlots: [],
    name: "Daily quick check",
    target: STAGING,
    tier: "scout",
    frequency: "daily",
    notifyEmail: "buyer@example.com",
    notifyOn: "new",
    notifyEmailConfirmed: true,
    status: "active",
    lastRun: { runId: "run_scout0001", status: "complete", finishedAt: "2026-11-09T02:04:12.000Z" },
    nextRunAt: "2026-11-10T02:00:00.000Z",
  },
  {
    id: "scan_weekly01",
    targetId: "tgt_staging01",
    timezone: "Australia/Sydney",
    loginSlots: ["user1", "admin"],
    name: "Weekly review",
    target: STAGING,
    tier: "probe",
    frequency: "weekly",
    notifyEmail: "security@example-shop.test",
    notifyOn: "new",
    notifyEmailConfirmed: false,
    status: "active",
    nextRunAt: "2026-11-16T02:00:00.000Z",
  },
  {
    id: "scan_monthly01",
    targetId: "tgt_staging01",
    timezone: "Australia/Sydney",
    loginSlots: ["admin", "user1", "user2", "other"],
    name: "Monthly deep scan",
    target: STAGING,
    tier: "siege",
    frequency: "monthly",
    notifyEmail: "buyer@example.com",
    notifyOn: "always",
    notifyEmailConfirmed: true,
    status: "paused",
    lastRun: { runId: DEMO_RUN_ID, status: "complete", finishedAt: "2026-11-02T03:15:48.000Z" },
  },
  {
    id: "scan_once0001",
    targetId: "tgt_portal001",
    timezone: "Australia/Sydney",
    loginSlots: ["admin", "user1", "user2", "other"],
    name: "Pre-launch report",
    target: "portal.swarm-demo.test",
    tier: "siege",
    frequency: "once",
    notifyEmail: "buyer@example.com",
    notifyOn: "always",
    notifyEmailConfirmed: true,
    status: "active",
    lastRun: { runId: DEMO_RUN_ID, status: "complete", finishedAt: "2026-10-28T05:40:00.000Z" },
  },
];

export const MOCK_ACCOUNT: AccountInfo = {
  credits: { scout: 0, sweep: 0, probe: 0, siege: 0 },
  unmetered: false,
};

const login = (username: string, description: string) => ({
  username,
  description,
  notes: "",
  passwordSaved: true as const,
});

/** The targets behind MOCK_SCANS. Saved passwords are only flagged, never present. */
export const MOCK_TARGETS: TargetView[] = [
  {
    id: "tgt_staging01",
    appUrl: `https://${STAGING}`,
    marketingUrl: "",
    scopeNotes: "",
    hosts: [STAGING],
    logins: {
      admin: login("swarm-test-admin", "Administrator"),
      user1: login("swarm-test-user1", "Standard customer"),
    },
    acknowledgedAt: "2026-10-01T00:00:00.000Z",
    scans: [
      { id: "scan_daily001", name: "Daily quick check" },
      { id: "scan_weekly01", name: "Weekly review" },
      { id: "scan_monthly01", name: "Monthly deep scan" },
    ],
  },
  {
    id: "tgt_portal001",
    appUrl: "https://portal.swarm-demo.test",
    marketingUrl: "",
    scopeNotes: "",
    hosts: ["portal.swarm-demo.test"],
    logins: {
      admin: login("swarm-test-admin", "Administrator"),
      user1: login("swarm-test-user1", "Standard customer"),
      user2: login("swarm-test-user2", "Second customer"),
      other: login("swarm-test-readonly", "Read-only auditor"),
    },
    acknowledgedAt: "2026-10-01T00:00:00.000Z",
    scans: [{ id: "scan_once0001", name: "Pre-launch report" }],
  },
];
