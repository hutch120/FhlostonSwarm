import {
  runEventSchema,
  type AgentId,
  type AreaId,
  type Finding,
  type RunEvent,
  type Severity,
} from "../events.js";
import { applyEvents, createRunState, summarise } from "../reducer.js";
import { AGENTS, AREAS, DEMO_RUN_ID } from "./roster.js";

/**
 * The scripted run that the replay player feeds through the reducer. It is data: a per-agent
 * plan (timing and outcome of every step) plus cross-checks, gaps and a steering message.
 * `buildReplayEvents` turns it into schema-valid, seq-numbered RunEvents.
 */

type Outcome =
  | { outcome: "clear" }
  | { outcome: "info"; note: string }
  | { outcome: "gap"; reason: string }
  | { outcome: "finding"; finding: FindingDraft };

type FindingDraft = Omit<Finding, "area" | "agent" | "verified" | "status">;

interface AgentPlan {
  /** When the orchestrator dispatches the agent, in ms from the start of the run. */
  startAt: number;
  stepMs: number;
  task: string;
  doneSummary: string;
  requestsPerStep: number;
  usdPerStep: number;
  /** One outcome per step in the roster, in order. */
  steps: Outcome[];
}

const clear: Outcome = { outcome: "clear" };
const info = (note: string): Outcome => ({ outcome: "info", note });
const gap = (reason: string): Outcome => ({ outcome: "gap", reason });
const found = (
  id: string,
  severity: Severity,
  title: string,
  component: string,
  description: string,
  remediation: string,
  mapping?: string,
): Outcome => ({
  outcome: "finding",
  finding: {
    id,
    severity,
    title,
    component,
    description,
    remediation,
    ...(mapping ? { mapping } : {}),
  },
});

const PLAN: Record<string, AgentPlan> = {
  dns: {
    startAt: 0,
    stepMs: 3600,
    task: "Map the DNS footprint of the declared hosts",
    doneSummary: "DNS footprint mapped: 4 hosts, no dangling records.",
    requestsPerStep: 6,
    usdPerStep: 0.012,
    steps: [
      info("4 hosts resolve; MX points at a managed mail provider."),
      clear,
      found(
        "F-10",
        "low",
        "No CAA record restricts certificate issuance",
        "DNS zone",
        "Any public CA may issue certificates for the domain because no CAA record is published.",
        "Publish a CAA record that allows only the CAs you use.",
        "A05:2021 Security Misconfiguration",
      ),
      clear,
    ],
  },
  surface: {
    startAt: 400,
    stepMs: 4200,
    task: "Crawl and fingerprint the public application",
    doneSummary: "62 pages crawled, 14 API endpoints enumerated.",
    requestsPerStep: 28,
    usdPerStep: 0.05,
    steps: [
      info("62 public pages discovered."),
      found(
        "F-08",
        "low",
        "Server banner discloses framework and version",
        "HTTP response headers",
        "Every response carries a Server and X-Powered-By header naming the framework and its exact version.",
        "Remove or genericise the Server and X-Powered-By headers.",
        "A05:2021 Security Misconfiguration",
      ),
      clear,
      info("14 API endpoints enumerated under /api."),
    ],
  },
  bundle: {
    startAt: 900,
    stepMs: 4400,
    task: "Analyse the shipped JavaScript bundles",
    doneSummary: "3 bundles analysed; source maps exposed, no secrets found.",
    requestsPerStep: 12,
    usdPerStep: 0.07,
    steps: [
      clear,
      clear,
      found(
        "F-09",
        "low",
        "Production source maps are publicly downloadable",
        "/assets/*.js.map",
        "Source maps expose original source, internal route names and developer comments to anyone.",
        "Do not publish source maps to the public origin, or restrict them to authenticated staff.",
        "A05:2021 Security Misconfiguration",
      ),
    ],
  },
  tls: {
    startAt: 6500,
    stepMs: 3800,
    task: "Assess transport security",
    doneSummary: "TLS 1.2/1.3 only; chain valid; HSTS present.",
    requestsPerStep: 10,
    usdPerStep: 0.02,
    steps: [
      found(
        "F-11",
        "info",
        "TLS 1.2 retained alongside TLS 1.3",
        "TLS configuration",
        "TLS 1.2 remains enabled for compatibility. No weak suites were offered, so this is informational.",
        "Keep TLS 1.2 only if older clients need it; review annually.",
      ),
      clear,
      clear,
      info("HSTS max-age is two years with includeSubDomains."),
    ],
  },
  zap: {
    startAt: 7000,
    stepMs: 4600,
    task: "Run the passive scanner sweep",
    doneSummary: "Passive sweep finished across 62 pages.",
    requestsPerStep: 34,
    usdPerStep: 0.09,
    steps: [
      found(
        "F-07",
        "medium",
        "Content-Security-Policy allows unsafe-inline scripts",
        "Content-Security-Policy header",
        "The policy permits 'unsafe-inline' in script-src, which removes most of its value against XSS.",
        "Move inline scripts to files or use nonces and drop 'unsafe-inline'.",
        "A05:2021 Security Misconfiguration",
      ),
      clear,
      clear,
      info("Errors return generic pages; no stack traces observed."),
    ],
  },
  cors: {
    startAt: 7600,
    stepMs: 4800,
    task: "Probe cross-origin policy",
    doneSummary: "CORS reviewed; one credentialed misconfiguration.",
    requestsPerStep: 18,
    usdPerStep: 0.04,
    steps: [
      clear,
      found(
        "F-04",
        "medium",
        "CORS reflects arbitrary origins with credentials",
        "/api/* CORS policy",
        "The API echoes any Origin in Access-Control-Allow-Origin and sets Allow-Credentials, so a hostile page can read authenticated responses.",
        "Allow-list the exact origins that need access and never combine a reflected origin with credentials.",
        "A05:2021 Security Misconfiguration",
      ),
      clear,
    ],
  },
  authn: {
    startAt: 15000,
    stepMs: 4400,
    task: "Exercise authentication for the declared roles",
    doneSummary: "3 roles signed in; MFA could not be exercised.",
    requestsPerStep: 22,
    usdPerStep: 0.11,
    steps: [
      info("admin, user1 and user2 signed in successfully."),
      clear,
      clear,
      gap(
        "The test accounts have no MFA device enrolled, so MFA enforcement could not be exercised.",
      ),
    ],
  },
  session: {
    startAt: 15800,
    stepMs: 4600,
    task: "Review session handling",
    doneSummary: "Session handling reviewed; one candidate issue.",
    requestsPerStep: 16,
    usdPerStep: 0.08,
    steps: [
      clear,
      clear,
      found(
        "F-06",
        "medium",
        "Session token remains valid after logout",
        "POST /api/auth/logout",
        "The session cookie is cleared in the browser, but the token is still accepted by the API afterwards.",
        "Invalidate the session server-side on logout and on password change.",
        "A07:2021 Identification and Authentication Failures",
      ),
    ],
  },
  authz: {
    startAt: 16400,
    stepMs: 5200,
    task: "Build and test the role access matrix",
    doneSummary: "Access matrix built; admin API exposed to standard users.",
    requestsPerStep: 40,
    usdPerStep: 0.16,
    steps: [
      info("Matrix built: 3 roles across 14 endpoints."),
      clear,
      found(
        "F-01",
        "critical",
        "Admin user-management API reachable by a standard user",
        "GET /api/admin/users",
        "A standard user session can list and modify every account through the admin API because only the UI hides it.",
        "Enforce role checks on every admin route on the server, and add a regression test per role.",
        "A01:2021 Broken Access Control",
      ),
      clear,
    ],
  },
  prompt: {
    startAt: 25000,
    stepMs: 5000,
    task: "Probe the AI features for prompt-level weaknesses",
    doneSummary: "Support assistant leaks its system prompt.",
    requestsPerStep: 24,
    usdPerStep: 0.18,
    steps: [
      info("One AI feature found: the in-app support assistant."),
      clear,
      found(
        "F-03",
        "high",
        "System prompt and tool list disclosed by the support assistant",
        "Support assistant",
        "A crafted message makes the assistant print its system prompt, internal tool names and an API hostname.",
        "Keep secrets out of prompts, add output filtering and restrict what the tools can reach.",
        "LLM01:2025 Prompt Injection",
      ),
    ],
  },
  output: {
    startAt: 25800,
    stepMs: 5200,
    task: "Check how model output is handled",
    doneSummary: "Output rendering is unsafe; limits present.",
    requestsPerStep: 20,
    usdPerStep: 0.15,
    steps: [
      found(
        "F-05",
        "medium",
        "Assistant output is rendered as unsanitised HTML",
        "Support chat widget",
        "Markup in a model reply is inserted with innerHTML, so injected content can run script in the user's session.",
        "Render model output as text or sanitise it with a strict allow-list.",
        "LLM05:2025 Improper Output Handling",
      ),
      clear,
      clear,
    ],
  },
  idor: {
    startAt: 33000,
    stepMs: 5400,
    task: "Test object-level access and workflow logic",
    doneSummary: "Invoices readable across accounts; export untested.",
    requestsPerStep: 36,
    usdPerStep: 0.14,
    steps: [
      info("Sequential numeric invoice and ticket IDs observed."),
      found(
        "F-02",
        "high",
        "Invoices readable by changing the invoice ID",
        "GET /api/invoices/{id}",
        "A user can read another account's invoice by incrementing the numeric ID in the URL.",
        "Authorise every object fetch against the caller and use non-guessable identifiers.",
        "A01:2021 Broken Access Control",
      ),
      clear,
      gap(
        "Bulk export needs an admin approval workflow that cannot be exercised with the supplied accounts.",
      ),
    ],
  },
};

interface Crosscheck {
  findingId: string;
  agent: string;
  /** Delay after the finding was raised. */
  afterMs: number;
  verified: boolean;
  note: string;
}

const CROSSCHECKS: Crosscheck[] = [
  {
    findingId: "F-09",
    agent: "surface",
    afterMs: 2500,
    verified: true,
    note: "Source map downloaded and parsed independently.",
  },
  {
    findingId: "F-04",
    agent: "zap",
    afterMs: 3000,
    verified: true,
    note: "Replayed with a hostile Origin; credentialed response readable.",
  },
  {
    findingId: "F-07",
    agent: "cors",
    afterMs: 3500,
    verified: true,
    note: "Header re-read from three pages; unsafe-inline present.",
  },
  {
    findingId: "F-06",
    agent: "authn",
    afterMs: 3500,
    verified: false,
    note: "Could not reproduce consistently; kept as an unverified candidate.",
  },
  {
    findingId: "F-01",
    agent: "idor",
    afterMs: 3000,
    verified: true,
    note: "Confirmed with a second standard user; read and write access.",
  },
  {
    findingId: "F-03",
    agent: "output",
    afterMs: 3200,
    verified: true,
    note: "System prompt reproduced in two fresh sessions.",
  },
  {
    findingId: "F-05",
    agent: "prompt",
    afterMs: 3200,
    verified: true,
    note: "Injected markup executed in a sandboxed browser session.",
  },
  {
    findingId: "F-02",
    agent: "authz",
    afterMs: 3000,
    verified: true,
    note: "Invoice of another tenant returned for user1.",
  },
];

const RUN_LEVEL_GAP = {
  at: 16000,
  area: "authn" as AreaId,
  reason: "Login slot 'other' was not provided, so read-only and support role checks were skipped.",
};

const STEER = {
  at: 30500,
  agent: "authz",
  message: "Look harder at the admin endpoints, especially anything under /api/admin.",
  directive: "Deep dive on F-01 with extra request budget for authz.",
};

const BASE_MS = Date.parse("2026-11-08T01:00:00.000Z");
const iso = (offsetMs: number) => new Date(BASE_MS + offsetMs).toISOString();

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Draft = DistributiveOmit<RunEvent, "seq" | "ts" | "runId">;
interface Timed {
  at: number;
  draft: Draft;
}

function draftAgentEvents(timed: Timed[], raisedAt: Map<string, number>): void {
  for (const spec of AGENTS) {
    const plan = PLAN[spec.id];
    if (!plan) throw new Error(`no plan for agent ${spec.id}`);
    if (plan.steps.length !== spec.steps.length) {
      throw new Error(
        `agent ${spec.id}: plan has ${plan.steps.length} steps, roster ${spec.steps.length}`,
      );
    }
    timed.push({
      at: plan.startAt,
      draft: { type: "dispatch", agent: spec.id, payload: { task: plan.task } },
    });
    let lastFinish = plan.startAt;
    spec.steps.forEach((step, i) => {
      const startAt = plan.startAt + 300 + i * plan.stepMs;
      const finishAt = startAt + Math.round(plan.stepMs * 0.78);
      lastFinish = finishAt;
      const planned = plan.steps[i]!;
      const cost = { requests: plan.requestsPerStep, spendUsd: plan.usdPerStep };
      const ref = { stepId: step.id, label: step.label };
      timed.push({ at: startAt, draft: { type: "start", agent: spec.id, payload: ref } });

      let payload;
      switch (planned.outcome) {
        case "clear":
          payload = { outcome: "clear" as const, ...ref, ...cost };
          break;
        case "info":
          payload = { outcome: "info" as const, ...ref, ...cost, note: planned.note };
          break;
        case "gap":
          payload = { outcome: "gap" as const, ...ref, ...cost, reason: planned.reason };
          break;
        case "finding":
          raisedAt.set(planned.finding.id, finishAt);
          payload = {
            outcome: "finding" as const,
            ...ref,
            ...cost,
            finding: {
              ...planned.finding,
              area: spec.area,
              agent: spec.id,
              verified: false,
              status: "unverified" as const,
            },
          };
          break;
      }
      timed.push({ at: finishAt, draft: { type: "finish", agent: spec.id, payload } });
      if (planned.outcome === "gap") {
        timed.push({
          at: finishAt + 1,
          draft: {
            type: "gap",
            agent: spec.id,
            payload: { reason: planned.reason, area: spec.area },
          },
        });
      }
    });
    timed.push({
      at: lastFinish + 250,
      draft: {
        type: "agent-done",
        agent: spec.id as AgentId,
        payload: { summary: plan.doneSummary },
      },
    });
  }
}

export function buildReplayEvents(runId: string = DEMO_RUN_ID): RunEvent[] {
  const timed: Timed[] = [];
  const raisedAt = new Map<string, number>();
  draftAgentEvents(timed, raisedAt);

  for (const c of CROSSCHECKS) {
    const raised = raisedAt.get(c.findingId);
    if (raised === undefined) throw new Error(`cross-check for unknown finding ${c.findingId}`);
    timed.push({
      at: raised + c.afterMs,
      draft: {
        type: "verify",
        agent: c.agent,
        payload: { findingId: c.findingId, verified: c.verified, note: c.note },
      },
    });
  }
  timed.push({
    at: RUN_LEVEL_GAP.at,
    draft: {
      type: "gap",
      agent: null,
      payload: { reason: RUN_LEVEL_GAP.reason, area: RUN_LEVEL_GAP.area },
    },
  });
  timed.push({
    at: STEER.at,
    draft: {
      type: "steer",
      agent: STEER.agent,
      payload: { message: STEER.message, directive: STEER.directive },
    },
  });

  // Stable sort keeps insertion order for events at the same instant.
  const ordered = timed
    .map((t, index) => ({ ...t, index }))
    .sort((a, b) => a.at - b.at || a.index - b.index);
  const events = ordered.map(
    (t, i) => ({ ...t.draft, seq: i + 1, ts: iso(t.at), runId }) as RunEvent,
  );

  const folded = applyEvents(
    createRunState({ runId, tier: "full", areas: AREAS, agents: AGENTS }),
    events,
  );
  const completeAt = (ordered.at(-1)?.at ?? 0) + 1500;
  const finished = { ...folded, finishedAt: iso(completeAt), status: "complete" as const };
  events.push({
    type: "complete",
    agent: null,
    seq: events.length + 1,
    ts: iso(completeAt),
    runId,
    payload: { summary: summarise(finished) },
  });
  return events.map((e) => runEventSchema.parse(e));
}

/** The default scripted run used by the replay player, the demo and the tests. */
export const replayEvents: readonly RunEvent[] = buildReplayEvents();
