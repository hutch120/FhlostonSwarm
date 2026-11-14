import {
  technologiesIn,
  tokensOf,
  type DynamicResults,
  type Engagement,
  type LearningStats,
  type RunStrings,
  type Snapshot,
} from "@swarm/shared/server";
import type { AppProfile, RunReport, TierId } from "@swarm/shared";

/**
 * What the learning pass reads from the run that just closed (PLAN.md section 9). The run is
 * reviewed, not only counted, but the digest handed to the model is deliberately generic: it holds
 * the depth, the names of roster checks and agents, counts and outcomes, the technologies from a
 * fixed vocabulary (name and version) and which learned entries applied. It never holds a host, a
 * path, a parameter, a login, evidence or any customer wording: those are only used, by
 * `runStringsOf`, to reject a proposal that repeats them. The digest is not stored anywhere.
 */
export interface RunData {
  runId: string;
  tier: TierId;
  /** A run of a test account: it learns into the test layer only. */
  test: boolean;
  report: RunReport;
  engagement: Engagement | null;
  profile: AppProfile | null;
  results: DynamicResults | null;
  /** The target the run was given, for `runStringsOf` only. */
  input: {
    hosts: readonly string[];
    urls: readonly string[];
    logins: readonly { username: string; password: string; description: string; notes: string }[];
    scopeNotes: string;
  };
  /** Paths the explorer opened. */
  pages: readonly string[];
}

/** Text of the run that a learned entry may never repeat. */
export function runStringsOf(run: RunData): RunStrings {
  const paths = new Set<string>();
  const add = (p: string | undefined | null) => p && p.startsWith("/") && paths.add(p);
  for (const p of run.pages) add(p);
  for (const p of run.engagement?.hints.routes ?? []) add(p);
  for (const p of run.engagement?.hints.apiBases ?? []) add(p);
  for (const f of run.engagement?.hints.ai ?? []) add(f.path);
  for (const a of run.profile?.areas ?? []) add(a.path);
  for (const finding of run.report.findings) {
    for (const m of finding.component.matchAll(/\s(\/\S*)/g)) add(m[1]);
  }
  const hosts = new Set<string>(run.input.hosts);
  for (const url of run.input.urls) {
    try {
      hosts.add(new URL(url).hostname);
    } catch {
      // Not a URL: nothing to forbid.
    }
  }
  const profile = run.profile;
  return {
    hosts: [...hosts],
    paths: [...paths],
    identifiers: run.input.logins.flatMap((l) => [l.username, l.password]),
    texts: [
      run.input.scopeNotes,
      ...run.input.logins.flatMap((l) => [l.description, l.notes]),
      ...(profile
        ? [
            profile.purpose,
            ...profile.areas.flatMap((a) => [a.name, a.description]),
            ...profile.roles.flatMap((r) => [r.name, r.description, ...r.access]),
            ...profile.flows.flatMap((f) => [f.name, f.description]),
          ]
        : []),
    ].filter((t) => t.trim().length > 0),
  };
}

/** A gap reason reduced to its kind, so no wording of the run reaches the digest. */
export function gapKind(reason: string): string {
  if (/coverage limit|budget|time limit/i.test(reason)) return "limit";
  if (/scope guard refused/i.test(reason)) return "scope-refused";
  if (/did not answer/i.test(reason)) return "no-answer";
  if (/failed unexpectedly|failed\b/i.test(reason)) return "failed";
  if (/not available yet/i.test(reason)) return "not-available";
  if (/not applicable/i.test(reason)) return "not-applicable";
  if (/read-only|state-changing|never tested|cannot be tested/i.test(reason)) return "needs-write";
  if (/login|sign-in|session/i.test(reason)) return "login";
  return "other";
}

/** The kinds of gap an extra check could have closed. */
const CLOSABLE = new Set(["limit", "not-available"]);

export interface Signals {
  uncoveredTechnology: string[];
  repeatedlyUnconfirmed: string[];
  closableGaps: { agent: string; kind: string; count: number }[];
  neverFired: string[];
}

export interface Digest {
  text: string;
  signals: Signals;
  technologies: { name: string; version?: string }[];
}

const count = <T>(items: readonly T[], key: (item: T) => string): Map<string, number> => {
  const out = new Map<string, number>();
  for (const item of items) out.set(key(item), (out.get(key(item)) ?? 0) + 1);
  return out;
};

/** The run as the learner sees it: bounded, generic and never stored. */
export function buildDigest(
  run: RunData,
  layer: Snapshot,
  stats: LearningStats,
  maxChars: number,
): Digest {
  const { report, engagement, profile } = run;
  const technologies = technologiesIn([
    ...(profile?.technologies ?? []),
    ...(engagement?.hints.apiBases.some((b) => b === "/graphql") ? ["graphql"] : []),
  ]);
  const features = {
    llm: (engagement?.hints.ai.length ?? 0) > 0,
    graphql: engagement?.hints.apiBases.includes("/graphql") ?? false,
    api: (engagement?.hints.apiBases.length ?? 0) > 0,
    logins: engagement?.roles.length ?? 0,
    roles: [...new Set(engagement?.roles.map((r) => r.kind) ?? [])],
  };

  const stepOf = new Map<string, string>();
  for (const phase of report.phases) {
    for (const check of phase.checks) {
      if (check.outcome === "finding" && check.detail) {
        stepOf.set(check.detail, `${check.agent}.${check.stepId}`);
      }
    }
  }
  const findings = report.findings.map((f) => ({
    check: stepOf.get(f.id) ?? `${f.agent}.?`,
    severity: f.severity,
    verification:
      f.status === "unconfirmed" ? "unconfirmed" : f.verified ? "confirmed" : "unchecked",
  }));

  const gaps = [...count(report.gaps, (g) => `${g.agent ?? "run"}|${gapKind(g.reason)}`)].map(
    ([key, n]) => {
      const [agent, kind] = key.split("|") as [string, string];
      return { agent, kind, count: n };
    },
  );
  const notApplicable = (report.plan?.notApplicable ?? []).map((n) => ({
    agent: n.agent,
    ...(n.step ? { step: n.step } : {}),
  }));

  const tokens = tokensOf(
    [],
    [
      ...technologies.map((t) => t.name),
      ...(features.llm ? ["llm", "ai"] : []),
      ...(features.graphql ? ["graphql"] : []),
      ...(features.api ? ["api"] : []),
    ],
  );
  const inUse = [...layer.items, ...layer.agents].filter((e) => e.status !== "retired");
  const covered = (tag: string) =>
    inUse.some((e) => e.appliesTo.some((t) => t !== "any" && t.split(" ").includes(tag)));
  const uncoveredTechnology = [...tokens].filter((t) => !covered(t));

  const unconfirmedNow = new Set(
    findings.filter((f) => f.verification === "unconfirmed").map((f) => f.check),
  );
  const repeatedlyUnconfirmed = [...unconfirmedNow].filter(
    (check) => (stats.checks[check]?.unconfirmed ?? 0) + 1 >= 2,
  );
  const closableGaps = gaps.filter((g) => CLOSABLE.has(g.kind));
  const neverFired = (run.results?.agents ?? [])
    .filter((a) => {
      const s = stats.agents[a.id];
      return (
        a.fired === 0 &&
        a.checks > 0 &&
        s !== undefined &&
        s.fires === 0 &&
        s.shadowRuns + s.activeRuns >= 2
      );
    })
    .map((a) => a.id);

  const body = {
    depth: run.tier,
    status: report.status,
    technologies,
    features,
    agentsNotApplicable: notApplicable,
    findingsByCheck: findings,
    gapsByKind: gaps,
    dynamicInThisRun: (run.results?.agents ?? []).map(
      ({ id, mode, checks, fired, errors, outOfScope, unconfirmed }) => ({
        id,
        mode,
        checks,
        fired,
        errors,
        outOfScope,
        unconfirmed,
      }),
    ),
    itemsApplied: (run.results?.items ?? []).map((i) => i.id),
    signals: { uncoveredTechnology, repeatedlyUnconfirmed, closableGaps, neverFired },
  };
  return {
    text: JSON.stringify(body, null, 1).slice(0, maxChars),
    signals: { uncoveredTechnology, repeatedlyUnconfirmed, closableGaps, neverFired },
    technologies,
  };
}

/** True when the run gave the learner something to think about. */
export const learnable = (s: Signals): boolean =>
  s.uncoveredTechnology.length +
    s.repeatedlyUnconfirmed.length +
    s.closableGaps.length +
    s.neverFired.length >
  0;
