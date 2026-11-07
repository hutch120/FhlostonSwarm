import {
  SEVERITIES,
  SEVERITY_RANK,
  type AgentSpec,
  type AreaId,
  type AreaSpec,
  type Finding,
  type RunEvent,
  type RunStatus,
  type Severity,
  type StepOutcome,
  type Summary,
  type TierId,
} from "./events.js";

export type AgentStatus = "idle" | "dispatched" | "working" | "done";

export interface StepRecord {
  stepId: string;
  label: string;
  /** null while the step is still running. */
  outcome: StepOutcome | null;
}

export interface AgentState {
  spec: AgentSpec;
  status: AgentStatus;
  task: string | null;
  currentStep: { id: string; label: string } | null;
  lastOutcome: StepOutcome | null;
  stepsDone: number;
  /** 0..1, steps finished over steps planned; 1 once the agent is done. */
  progress: number;
  findings: number;
  history: StepRecord[];
  doneSummary: string | null;
}

export interface GapRecord {
  seq: number;
  ts: string;
  agent: string | null;
  area: AreaId | null;
  reason: string;
}

export interface SteerRecord {
  seq: number;
  ts: string;
  agent: string | null;
  message: string;
  directive: string | null;
}

export interface RunState {
  runId: string;
  tier: TierId;
  status: RunStatus | "idle";
  /** Highest seq applied; events at or below it are ignored. */
  lastSeq: number;
  startedAt: string | null;
  lastEventAt: string | null;
  finishedAt: string | null;
  areas: AreaSpec[];
  agentOrder: string[];
  agents: Record<string, AgentState>;
  /** Always sorted by severity (worst first), then id. */
  findings: Finding[];
  gaps: GapRecord[];
  steering: SteerRecord[];
  log: RunEvent[];
  checks: number;
  requests: number;
  spendUsd: number;
  /** The backend's authoritative summary, set by the `complete` event. */
  summary: Summary | null;
}

export interface RunStateInit {
  runId: string;
  tier: TierId;
  areas: readonly AreaSpec[];
  agents: readonly AgentSpec[];
}

export function createRunState(init: RunStateInit): RunState {
  const agents: Record<string, AgentState> = {};
  for (const spec of init.agents) {
    agents[spec.id] = {
      spec,
      status: "idle",
      task: null,
      currentStep: null,
      lastOutcome: null,
      stepsDone: 0,
      progress: 0,
      findings: 0,
      history: [],
      doneSummary: null,
    };
  }
  return {
    runId: init.runId,
    tier: init.tier,
    status: "idle",
    lastSeq: 0,
    startedAt: null,
    lastEventAt: null,
    finishedAt: null,
    areas: [...init.areas],
    agentOrder: init.agents.map((a) => a.id),
    agents,
    findings: [],
    gaps: [],
    steering: [],
    log: [],
    checks: 0,
    requests: 0,
    spendUsd: 0,
    summary: null,
  };
}

export function compareFindings(a: Finding, b: Finding): number {
  return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.id.localeCompare(b.id);
}

function withAgent(
  state: RunState,
  id: string,
  update: (agent: AgentState) => AgentState,
): RunState["agents"] {
  const agent = state.agents[id];
  return agent ? { ...state.agents, [id]: update(agent) } : state.agents;
}

function progressOf(agent: AgentState, stepsDone: number): number {
  return Math.min(1, stepsDone / agent.spec.steps.length);
}

/**
 * Pure reducer. Idempotent: an event whose seq is not above the last applied seq (a duplicate or a
 * late, out-of-order arrival) leaves the state untouched, so replays and reconnects are safe. The
 * transport is responsible for delivering a gap-free ordered stream (it can reload from S3).
 */
export function applyEvent(state: RunState, event: RunEvent): RunState {
  if (event.runId !== state.runId || event.seq <= state.lastSeq) return state;

  const base: RunState = {
    ...state,
    lastSeq: event.seq,
    startedAt: state.startedAt ?? event.ts,
    lastEventAt: event.ts,
    status: state.status === "idle" ? "running" : state.status,
    log: [...state.log, event],
  };

  switch (event.type) {
    case "dispatch":
      return {
        ...base,
        agents: withAgent(base, event.agent, (a) => ({
          ...a,
          status: "dispatched",
          task: event.payload.task,
        })),
      };

    case "start":
      return {
        ...base,
        agents: withAgent(base, event.agent, (a) => ({
          ...a,
          status: "working",
          currentStep: { id: event.payload.stepId, label: event.payload.label },
          history: [
            ...a.history,
            { stepId: event.payload.stepId, label: event.payload.label, outcome: null },
          ],
        })),
      };

    case "finish": {
      const { payload } = event;
      const finding = payload.outcome === "finding" ? payload.finding : null;
      const known = finding ? state.findings.some((f) => f.id === finding.id) : true;
      return {
        ...base,
        checks: base.checks + (payload.outcome === "gap" ? 0 : 1),
        requests: base.requests + payload.requests,
        spendUsd: roundUsd(base.spendUsd + payload.spendUsd),
        findings:
          finding && !known ? [...base.findings, finding].sort(compareFindings) : base.findings,
        agents: withAgent(base, event.agent, (a) => {
          const stepsDone = a.stepsDone + 1;
          const history = a.history.map((h) =>
            h.stepId === payload.stepId && h.outcome === null
              ? { ...h, outcome: payload.outcome }
              : h,
          );
          return {
            ...a,
            currentStep: null,
            lastOutcome: payload.outcome,
            stepsDone,
            progress: progressOf(a, stepsDone),
            findings: a.findings + (finding && !known ? 1 : 0),
            history,
          };
        }),
      };
    }

    case "verify":
      return {
        ...base,
        findings: base.findings.map((f) =>
          f.id === event.payload.findingId
            ? {
                ...f,
                verified: event.payload.verified,
                status: event.payload.verified ? "open" : "unverified",
              }
            : f,
        ),
      };

    case "agent-done":
      return {
        ...base,
        agents: withAgent(base, event.agent, (a) => ({
          ...a,
          status: "done",
          currentStep: null,
          progress: 1,
          doneSummary: event.payload.summary,
        })),
      };

    case "gap":
      return {
        ...base,
        gaps: [
          ...base.gaps,
          {
            seq: event.seq,
            ts: event.ts,
            agent: event.agent,
            area: event.payload.area ?? null,
            reason: event.payload.reason,
          },
        ],
      };

    case "steer":
      return {
        ...base,
        steering: [
          ...base.steering,
          {
            seq: event.seq,
            ts: event.ts,
            agent: event.agent,
            message: event.payload.message,
            directive: event.payload.directive ?? null,
          },
        ],
      };

    case "complete":
      return {
        ...base,
        status: event.payload.summary.status,
        finishedAt: event.ts,
        summary: event.payload.summary,
      };
  }
}

export function applyEvents(state: RunState, events: readonly RunEvent[]): RunState {
  return events.reduce(applyEvent, state);
}

const roundUsd = (n: number) => Math.round(n * 10_000) / 10_000;

export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

/** The live counters as a Summary; the `complete` event's summary is the backend's version of this. */
export function summarise(state: RunState): Summary {
  const startedAt = state.startedAt ?? new Date(0).toISOString();
  const end = state.finishedAt ?? state.lastEventAt ?? startedAt;
  const agents = Object.values(state.agents);
  return {
    runId: state.runId,
    status: state.status === "idle" ? "queued" : state.status,
    tier: state.tier,
    startedAt,
    ...(state.finishedAt ? { finishedAt: state.finishedAt } : {}),
    durationMs: Math.max(0, Date.parse(end) - Date.parse(startedAt)),
    checks: state.checks,
    requests: state.requests,
    spendUsd: state.spendUsd,
    findings: {
      total: state.findings.length,
      verified: state.findings.filter((f) => f.verified).length,
      bySeverity: countBySeverity(state.findings),
    },
    gaps: state.gaps.length,
    agents: { total: agents.length, done: agents.filter((a) => a.status === "done").length },
  };
}

export interface AreaProgress {
  spec: AreaSpec;
  agentIds: string[];
  agentsDone: number;
  /** 0..1, mean of its agents' progress. */
  progress: number;
  findings: number;
}

export function selectAreas(state: RunState): AreaProgress[] {
  return state.areas.map((spec) => {
    const agents = state.agentOrder
      .map((id) => state.agents[id]!)
      .filter((a) => a.spec.area === spec.id);
    const total = agents.length;
    return {
      spec,
      agentIds: agents.map((a) => a.spec.id),
      agentsDone: agents.filter((a) => a.status === "done").length,
      progress: total === 0 ? 0 : agents.reduce((sum, a) => sum + a.progress, 0) / total,
      findings: agents.reduce((sum, a) => sum + a.findings, 0),
    };
  });
}
