import {
  AGENTS,
  AREAS,
  DEMO_RUN_ID,
  DEMO_TARGET,
  applyEvents,
  createRunState,
  replayEvents,
  summarise,
  type Summary,
} from "@swarm/shared";

export interface RunListItem {
  summary: Summary;
  target: string;
}

export interface AccountInfo {
  freeLiteRemaining: number;
  paidCredits: number;
}

const demoSummary = (): Summary =>
  summarise(
    applyEvents(
      createRunState({ runId: DEMO_RUN_ID, tier: "full", areas: AREAS, agents: AGENTS }),
      replayEvents,
    ),
  );

const liteSummary: Summary = {
  runId: "run_lite0001",
  status: "complete",
  tier: "lite",
  startedAt: "2026-11-02T03:10:00.000Z",
  finishedAt: "2026-11-02T03:15:48.000Z",
  durationMs: 348_000,
  checks: 22,
  requests: 118,
  spendUsd: 0.31,
  findings: {
    total: 5,
    verified: 2,
    bySeverity: { critical: 0, high: 1, medium: 2, low: 2, info: 0 },
  },
  gaps: 2,
  agents: { total: 6, done: 6 },
};

/** Fixed mock rows for the static screens. Replaced by the real API in Phase 4. */
export const MOCK_RUNS: RunListItem[] = [
  { summary: demoSummary(), target: DEMO_TARGET },
  { summary: liteSummary, target: "staging.example-shop.test" },
];

export const MOCK_ACCOUNT: AccountInfo = { freeLiteRemaining: 1, paidCredits: 0 };
