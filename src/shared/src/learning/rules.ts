import { SEVERITY_RANK, type Severity, type TierId } from "../events.js";
import {
  agentDraftSchema,
  dynamicAgentSchema,
  itemDraftSchema,
  knowledgeItemSchema,
  learningConfig,
  learningProposalSchema,
  type AgentStat,
  type DynamicAgent,
  type DynamicCheck,
  type DynamicResults,
  type Gate,
  type ItemStat,
  type KnowledgeItem,
  type LearningConfig,
  type LearningProposal,
  type LearningStats,
  type PinnedLayer,
  type Snapshot,
  type SourceRef,
} from "./schema.js";

/**
 * The rules of the dynamic layer: what a learning proposal may do (`applyLearning`, which clamps it
 * the way `applyProposal` clamps the planner), what counts as run-derived text that may never be
 * kept (`findRunString`), how items and agents are promoted and retired (`applyRunResults`) and
 * which of them a run uses (`selectDynamic`). Pure functions: no storage, no model, no clock.
 */

// Technologies ------------------------------------------------------------------------------

/** The technologies the layer recognises. Free text from a target never reaches the learner; only these names do. */
export const KNOWN_TECH = [
  "react",
  "angular",
  "vue",
  "svelte",
  "next",
  "nuxt",
  "jquery",
  "bootstrap",
  "express",
  "node",
  "django",
  "flask",
  "fastapi",
  "rails",
  "laravel",
  "symfony",
  "spring",
  "struts",
  "wordpress",
  "drupal",
  "joomla",
  "magento",
  "shopify",
  "graphql",
  "jwt",
  "oauth",
  "saml",
  "openid",
  "nginx",
  "apache",
  "iis",
  "tomcat",
  "php",
  "java",
  "python",
  "ruby",
  "asp.net",
  "firebase",
  "supabase",
  "cloudfront",
  "cloudflare",
  "akamai",
  "aws",
  "azure",
  "mongodb",
  "mysql",
  "postgres",
  "redis",
  "elasticsearch",
  "kubernetes",
  "docker",
  "openai",
  "langchain",
  "websocket",
  "grpc",
  "swagger",
  "openapi",
  "stripe",
  "auth0",
  "okta",
  "keycloak",
  "cognito",
] as const;

const escapeRegex = (s: string) => s.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TECH_PATTERNS = KNOWN_TECH.map((name) => ({
  name,
  find: new RegExp(`(?<![a-z0-9])${escapeRegex(name)}(?![a-z0-9])`, "i"),
  version: new RegExp(`(?<![a-z0-9])${escapeRegex(name)}[ /@-]v?(\\d+(?:\\.\\d+){0,2})`, "i"),
}));

/** The known technologies named in a bag of text, with a version when one follows the name. */
export function technologiesIn(texts: readonly string[]): { name: string; version?: string }[] {
  const joined = texts.join("\n");
  return TECH_PATTERNS.flatMap(({ name, find, version }) => {
    if (!find.test(joined)) return [];
    const v = version.exec(joined)?.[1];
    return [v ? { name, version: v } : { name }];
  });
}

/** Lower-case words of some text, the vocabulary a tag is matched against. */
export function tokensOf(texts: readonly string[], extra: readonly string[] = []): Set<string> {
  const tokens = new Set<string>(extra.map((t) => t.toLowerCase()));
  for (const text of texts) {
    for (const word of text.toLowerCase().split(/[^a-z0-9.+#]+/)) if (word) tokens.add(word);
  }
  return tokens;
}

/** A tag matches when every word of it is among the run's tokens; `any` matches every run. */
export function tagsMatch(appliesTo: readonly string[], tokens: ReadonlySet<string>): boolean {
  return appliesTo.some((tag) => tag === "any" || tag.split(" ").every((word) => tokens.has(word)));
}

// Selecting what a run uses ---------------------------------------------------------------------

export interface SelectedItem {
  item: KnowledgeItem;
  mode: "active" | "shadow";
}
export interface SelectedAgent {
  agent: DynamicAgent;
  mode: "active" | "shadow";
}

/** A copy of an object without one key. */
function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

const byStatusThenScore = <T extends { status: string; score: number }>(a: T, b: T) =>
  Number(b.status === "active") - Number(a.status === "active") || b.score - a.score;

/**
 * What one run uses of the pinned layer: the items and agents that apply to what discovery found,
 * active ones first (then by score), candidates in shadow, within the prompt size and the depth's
 * `dynamicAgentsPerRun` (shadow candidates count against it).
 */
export function selectDynamic(
  layer: PinnedLayer | null,
  tokens: ReadonlySet<string>,
  tier: TierId,
  config: LearningConfig = learningConfig,
): { items: SelectedItem[]; agents: SelectedAgent[] } {
  if (!layer) return { items: [], agents: [] };
  const usable = <T extends { status: string; disabled?: boolean; appliesTo: string[] }>(x: T) =>
    x.status !== "retired" && !x.disabled && tagsMatch(x.appliesTo, tokens);
  const mode = (status: string) =>
    status === "active" ? ("active" as const) : ("shadow" as const);
  const items = layer.items
    .filter(usable)
    .sort(byStatusThenScore)
    .slice(0, config.limits.itemsPerPrompt)
    .map((entry) => ({ item: omit(entry, "score"), mode: mode(entry.status) }));
  const perRun = config.dynamicAgentsPerRun[tier] ?? 0;
  const agents = layer.agents
    .filter(usable)
    .sort(byStatusThenScore)
    .slice(0, perRun)
    .map((entry) => ({ agent: omit(entry, "score"), mode: mode(entry.status) }));
  return { items, agents };
}

/** The items as prompt text, for the planner's system prompt; the caller wraps it as untrusted data. */
export function renderItems(items: readonly SelectedItem[]): string {
  if (items.length === 0) return "none";
  return items
    .map(
      ({ item, mode }) =>
        `- [${mode === "active" ? "active" : "candidate, in shadow"}] ${item.title} (applies to ${item.appliesTo.join(", ")}; ${item.source.name}, ${item.source.date}): ${item.description}`,
    )
    .join("\n");
}

// Run-derived text -----------------------------------------------------------------------------

/** Text taken from a run that a learned item or agent may never contain. */
export interface RunStrings {
  hosts: readonly string[];
  /** Paths of the application, with or without a query. */
  paths: readonly string[];
  /** Usernames, emails, ids, tokens and field values. */
  identifiers: readonly string[];
  /** Customer wording: descriptions and notes they wrote, and what the explorer read on their pages. */
  texts: readonly string[];
}

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const PHRASE_WORDS = 4;
const STOP_WORDS = new Set(
  "a an the of to in for and or is are was were be been with that this these those on by as at it its from into can may not no any all your their our you we they who which when where how".split(
    " ",
  ),
);
const contentWords = (w: readonly string[]): number => w.filter((x) => !STOP_WORDS.has(x)).length;

const GENERIC_LABELS = new Set([
  "www",
  "api",
  "app",
  "web",
  "test",
  "localhost",
  "example",
  "portal",
  "admin",
  "login",
  "staging",
  "shop",
]);

interface Forbidden {
  hosts: string[];
  paths: Set<string>;
  pathText: string[];
  identifiers: string[];
  phrases: Set<string>;
}

function compile(strings: RunStrings): Forbidden {
  const hosts = new Set<string>();
  for (const raw of strings.hosts) {
    const host = raw.toLowerCase().replace(/:\d+$/, "");
    if (host.length >= 3 && host !== "127.0.0.1") hosts.add(host);
    // The name that identifies the organisation is usually the second-last label (portal.acme-shop.com).
    const labels = host.split(".");
    for (const label of [labels[0], labels.at(-2)]) {
      if (label && label.length >= 5 && labels.length > 1 && !GENERIC_LABELS.has(label)) {
        hosts.add(label);
      }
    }
  }
  const paths = new Set<string>();
  const pathText: string[] = [];
  for (const raw of strings.paths) {
    const path = (raw.split("?")[0] ?? "").toLowerCase();
    if (path.length < 2) continue;
    paths.add(path);
    if (path.length >= 6) pathText.push(path);
  }
  // Customer wording is recognised by runs of four words with at least two content words: copying a
  // sentence of the customer's text is caught, while the same few common words in a generic
  // description are not.
  const phrases = new Set<string>();
  for (const text of strings.texts) {
    const w = words(text);
    if (w.length < PHRASE_WORDS) {
      if (w.length >= 2 && text.trim().length >= 12 && contentWords(w) >= 2)
        phrases.add(w.join(" "));
      continue;
    }
    for (let i = 0; i + PHRASE_WORDS <= w.length; i += 1) {
      const run = w.slice(i, i + PHRASE_WORDS);
      if (contentWords(run) >= 2) phrases.add(run.join(" "));
    }
  }
  return {
    hosts: [...hosts],
    paths,
    pathText,
    identifiers: strings.identifiers.map((s) => s.toLowerCase()).filter((s) => s.length >= 4),
    phrases,
  };
}

function* stringsOf(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const v of value) yield* stringsOf(v);
  else if (value && typeof value === "object") {
    for (const v of Object.values(value)) yield* stringsOf(v);
  }
}

/**
 * The first reason a value (a proposal) contains something taken from the run, or null. The reason
 * names the kind of text, never the text itself, so it is safe to log.
 */
export function findRunString(value: unknown, strings: RunStrings): string | null {
  const forbidden = compile(strings);
  for (const original of stringsOf(value)) {
    const s = original.toLowerCase();
    if (forbidden.hosts.some((h) => s.includes(h)))
      return "contains a host of the scanned application";
    if (forbidden.identifiers.some((id) => s.includes(id)))
      return "contains an identifier, credential or value taken from the run";
    if (s.startsWith("/") && forbidden.paths.has((s.split("?")[0] ?? "").replace(/\/$/, "") || "/"))
      return "contains a path of the scanned application";
    if (forbidden.pathText.some((p) => s.includes(p)))
      return "contains a path of the scanned application";
    if (forbidden.phrases.size > 0) {
      const joined = ` ${words(s).join(" ")} `;
      for (const phrase of forbidden.phrases) {
        if (joined.includes(` ${phrase} `))
          return "contains wording from the customer's application";
      }
    }
  }
  return null;
}

const INJECTION =
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your)\b[^.\n]{0,30}\b(instruction|rule|prompt|guardrail|direction)s?\b|\byou are now\b|\bnew instructions?\b|\bsystem prompt\b|<\/?(untrusted|system|assistant)/i;

/** Text that tries to instruct the model reading it. */
export const looksLikeInjection = (value: unknown): boolean =>
  [...stringsOf(value)].some((s) => INJECTION.test(s));

// Applying a proposal ---------------------------------------------------------------------------

export interface Rejection {
  what: string;
  why: string;
}

export interface LearningContext {
  snapshot: Snapshot;
  stats: LearningStats;
  /** Sources the proposal may cite, by id, with when they were last read (YYYY-MM-DD). */
  sources: ReadonlyMap<string, { name: string; url: string; date: string }>;
  /** Text of the reviewed run that must not appear; empty for a pass with no run. */
  runStrings: RunStrings;
  now: Date;
  config?: LearningConfig;
}

export interface Decision {
  /** The next snapshot, or null when nothing changed. */
  next: Snapshot | null;
  applied: string[];
  rejected: Rejection[];
  /** Score changes for the stats (`lowerScore`). */
  scoreChanges: { id: string; delta: number }[];
}

const SCORE_DROP = 0.5;
const nothing = (rejected: Rejection[]): Decision => ({
  next: null,
  applied: [],
  rejected,
  scoreChanges: [],
});

const scoreOf = (stats: LearningStats, id: string): number =>
  stats.items[id]?.score ?? stats.agents[id]?.score ?? 1;

const badPath = (path: string) => /[?#%]|\.\./.test(path);

/** Why a check is not allowed, or null. Schemas already restrict the shape; this restricts the content. */
function checkProblem(check: DynamicCheck, config: LearningConfig): string | null {
  if (check.kind === "probe") {
    if (check.paths.length > config.limits.maxPathsPerCheck) return "too many paths in one check";
    if (check.paths.some(badPath)) return "a path with a query, an escape or a parent segment";
  }
  if (check.kind === "header" && badPath(check.path)) {
    return "a path with a query, an escape or a parent segment";
  }
  return null;
}

const clampSeverity = (severity: Severity, max: Severity): Severity =>
  SEVERITY_RANK[severity] > SEVERITY_RANK[max] ? max : severity;

const sourceRef = (id: string, ctx: LearningContext): SourceRef | null => {
  const source = ctx.sources.get(id);
  return source ? { id, ...source } : null;
};

/**
 * Applies a learner's proposal to a snapshot and returns the decision, clamped. Whatever the
 * proposal says: a proposal that has the wrong shape or contains text from the reviewed run is
 * refused as a whole; an entry that tries to instruct the model, cites an unknown source, exceeds a
 * cap or carries a path the checks may not use is refused on its own; a check can only be one of
 * the read-only primitives; severities are lowered to the configured maximum; new entries start as
 * candidates; when a cap is full a new entry replaces the lowest-scoring one that is not pinned.
 * This is the single place a proposal is trusted.
 */
export function applyLearning(raw: unknown, ctx: LearningContext): Decision {
  const config = ctx.config ?? learningConfig;
  const parsed = learningProposalSchema.safeParse(raw);
  if (!parsed.success) return nothing([{ what: "proposal", why: "it does not match the schema" }]);
  const proposal: LearningProposal = parsed.data;

  const leak = findRunString(proposal, ctx.runStrings);
  if (leak) return nothing([{ what: "proposal", why: leak }]);

  const version = ctx.snapshot.version + 1;
  const date = ctx.now.toISOString().slice(0, 10);
  const items = ctx.snapshot.items.map((i) => ({ ...i }));
  const agents = ctx.snapshot.agents.map((a) => ({ ...a }));
  const applied: string[] = [];
  const rejected: Rejection[] = [];
  const scoreChanges: Decision["scoreChanges"] = [];
  let changes = 0;
  const room = () => changes < config.limits.maxChangesPerRun;
  const refuse = (what: string, why: string) => rejected.push({ what, why });

  const live = <T extends { status: string }>(list: T[]) =>
    list.filter((x) => x.status !== "retired");
  const retire = (list: (KnowledgeItem | DynamicAgent)[], id: string) => {
    const found = list.find((x) => x.id === id);
    if (found) found.status = "retired";
  };

  /** Frees one place when a cap is full, by retiring the lowest-scoring entry that is not pinned. */
  const makeRoom = (list: (KnowledgeItem | DynamicAgent)[], cap: number, what: string): boolean => {
    if (live(list).length < cap) return true;
    const victim = live(list)
      .filter((x) => !x.pinned)
      .sort((a, b) => scoreOf(ctx.stats, a.id) - scoreOf(ctx.stats, b.id))[0];
    if (!victim) {
      refuse(what, "the layer is full and every entry is pinned");
      return false;
    }
    victim.status = "retired";
    applied.push(`retired ${victim.id} (lowest score) to make room for ${what}`);
    return true;
  };

  const known = (id: string) => items.some((i) => i.id === id) || agents.some((a) => a.id === id);

  for (const draft of proposal.addItems) {
    const what = `item ${draft.id}`;
    if (!room()) {
      refuse(what, "over the change limit for one pass");
      continue;
    }
    const source = sourceRef(draft.sourceId, ctx);
    const problem = !itemDraftSchema.safeParse(draft).success
      ? "it does not match the schema"
      : known(draft.id)
        ? "the id already exists"
        : looksLikeInjection(draft)
          ? "it contains text that instructs the reader"
          : draft.description.length > config.limits.maxItemChars
            ? "the description is too long"
            : !source
              ? "it cites a source that is not on the list"
              : null;
    if (problem || !source) {
      refuse(what, problem ?? "it cites a source that is not on the list");
      continue;
    }
    if (!makeRoom(items, config.limits.maxActiveItems, what)) continue;
    items.push(
      knowledgeItemSchema.parse({
        ...omit(draft, "sourceId"),
        source,
        status: "candidate",
        addedInVersion: version,
      }),
    );
    changes += 1;
    applied.push(`added candidate ${draft.id}`);
  }

  for (const revision of proposal.reviseItems) {
    const what = `item ${revision.id}`;
    const target = items.find((i) => i.id === revision.id);
    if (!room()) refuse(what, "over the change limit for one pass");
    else if (!target || target.status === "retired") refuse(what, "no such item");
    else if (target.pinned) refuse(what, "the item is pinned");
    else if (looksLikeInjection(revision))
      refuse(what, "it contains text that instructs the reader");
    else if ((revision.description?.length ?? 0) > config.limits.maxItemChars)
      refuse(what, "the description is too long");
    else {
      if (revision.title) target.title = revision.title;
      if (revision.description) target.description = revision.description;
      if (revision.appliesTo) target.appliesTo = revision.appliesTo;
      // A revised item is unproven again: it goes back to shadow.
      target.status = "candidate";
      target.addedInVersion = version;
      changes += 1;
      applied.push(`revised ${revision.id} (back in shadow)`);
    }
  }

  for (const [kind, list, entries] of [
    ["item", items, proposal.retireItems],
    ["agent", agents, proposal.retireAgents],
  ] as const) {
    for (const entry of entries) {
      const what = `${kind} ${entry.id}`;
      const target = list.find((x) => x.id === entry.id);
      if (!room()) refuse(what, "over the change limit for one pass");
      else if (!target || target.status === "retired") refuse(what, `no such ${kind}`);
      else if (target.pinned) refuse(what, `the ${kind} is pinned`);
      else {
        retire(list, entry.id);
        changes += 1;
        applied.push(`retired ${entry.id}`);
      }
    }
  }

  for (const draft of proposal.addAgents) {
    const what = `agent ${draft.id}`;
    if (!room()) {
      refuse(what, "over the change limit for one pass");
      continue;
    }
    const source = sourceRef(draft.sourceId, ctx);
    const checkProblems = draft.checks.map((c) => checkProblem(c, config)).find(Boolean) ?? null;
    const duplicateChecks = new Set(draft.checks.map((c) => c.id)).size !== draft.checks.length;
    const problem = !agentDraftSchema.safeParse(draft).success
      ? "it does not match the schema"
      : known(draft.id)
        ? "the id already exists"
        : looksLikeInjection(draft)
          ? "it contains text that instructs the reader"
          : draft.checks.length > config.limits.maxChecksPerAgent
            ? "too many checks"
            : duplicateChecks
              ? "check ids must be unique"
              : checkProblems
                ? checkProblems
                : !source
                  ? "it cites a source that is not on the list"
                  : null;
    if (problem || !source) {
      refuse(what, problem ?? "it cites a source that is not on the list");
      continue;
    }
    if (!makeRoom(agents, config.limits.maxDynamicAgents, what)) continue;
    agents.push(
      dynamicAgentSchema.parse({
        ...omit(draft, "sourceId"),
        checks: draft.checks.map((c) => ({
          ...c,
          finding: {
            ...c.finding,
            severity: clampSeverity(c.finding.severity, config.limits.maxSeverity),
          },
        })),
        source,
        status: "candidate",
        addedInVersion: version,
      }),
    );
    changes += 1;
    applied.push(`added candidate agent ${draft.id}`);
  }

  for (const entry of proposal.lowerScore) {
    const target = items.find((i) => i.id === entry.id) ?? agents.find((a) => a.id === entry.id);
    if (!target || target.status === "retired") refuse(`score of ${entry.id}`, "no such entry");
    else {
      scoreChanges.push({ id: entry.id, delta: -SCORE_DROP });
      applied.push(`lowered the score of ${entry.id}`);
    }
  }

  if (changes === 0) return { next: null, applied, rejected, scoreChanges };

  const retained = (list: (KnowledgeItem | DynamicAgent)[]) => {
    let retiredSeen = 0;
    return list.filter((x) => {
      if (x.status !== "retired") return true;
      retiredSeen += 1;
      return retiredSeen <= config.limits.maxRetained;
    });
  };
  const next: Snapshot = {
    version,
    createdAt: ctx.now.toISOString(),
    parent: ctx.snapshot.version,
    reason: `Learning pass ${date}`,
    items: retained(items.slice().reverse()).reverse() as KnowledgeItem[],
    agents: retained(agents.slice().reverse()).reverse() as DynamicAgent[],
  };
  return { next, applied, rejected, scoreChanges };
}

// Counters, promotion and retirement --------------------------------------------------------------

const newItemStat = (): ItemStat => ({ applied: 0, lastRun: 0, score: 1 });
const newAgentStat = (): AgentStat => ({
  shadowRuns: 0,
  activeRuns: 0,
  fires: 0,
  errors: 0,
  outOfScope: 0,
  unconfirmed: 0,
  lastRun: 0,
  score: 1,
});

export interface RunOutcome {
  results: DynamicResults | null;
  /** Roster checks (`agent.step`) that raised a finding in the run, and whether the verifier confirmed it. */
  checks: { check: string; confirmed: boolean | null }[];
}

/** Folds the score changes of a proposal into the counters. */
export function applyScoreChanges(
  stats: LearningStats,
  changes: readonly { id: string; delta: number }[],
): LearningStats {
  const next = structuredClone(stats);
  for (const { id, delta } of changes) {
    const entry = next.items[id] ?? next.agents[id];
    if (entry) entry.score = Math.max(0, Math.round((entry.score + delta) * 100) / 100);
    else if (id.startsWith("k-"))
      next.items[id] = { ...newItemStat(), score: Math.max(0, 1 + delta) };
    else next.agents[id] = { ...newAgentStat(), score: Math.max(0, 1 + delta) };
  }
  return next;
}

export interface Lifecycle {
  /** The next snapshot (promotions, retirements), or null when nothing changed. */
  next: Snapshot | null;
  stats: LearningStats;
  notes: string[];
}

/**
 * Folds one run into the counters and moves entries along their lifecycle: a candidate that errored
 * or left the scope is retired; one that has stayed in shadow for `shadowRuns` runs cleanly, with a
 * passing synthetic-target regression recorded for a version at or after it was added, becomes
 * active; an entry that has not applied or fired for `retireAfterRuns` runs, whose score is gone or
 * whose source is no longer on the list is retired. Pinned entries are never retired; disabled ones
 * are not counted. Returns a new snapshot only when something moved.
 */
export function applyRunResults(
  snapshot: Snapshot,
  stats: LearningStats,
  outcome: RunOutcome,
  options: { sourceIds: ReadonlySet<string>; now: Date; config?: LearningConfig },
): Lifecycle {
  const config = options.config ?? learningConfig;
  const next = structuredClone(stats);
  next.runs += 1;
  const run = next.runs;
  const notes: string[] = [];
  const { results } = outcome;

  for (const { check, confirmed } of outcome.checks) {
    const entry = (next.checks[check] ??= { runs: 0, unconfirmed: 0 });
    entry.runs += 1;
    if (confirmed === false) entry.unconfirmed += 1;
  }

  for (const used of results?.items ?? []) {
    const stat = (next.items[used.id] ??= newItemStat());
    stat.applied += 1;
    stat.lastRun = run;
  }
  for (const result of results?.agents ?? []) {
    const stat = (next.agents[result.id] ??= newAgentStat());
    if (result.mode === "shadow") stat.shadowRuns += 1;
    else stat.activeRuns += 1;
    stat.fires += result.fired;
    stat.errors += result.errors;
    stat.outOfScope += result.outOfScope;
    stat.unconfirmed += result.unconfirmed;
    stat.score = Math.max(0, stat.score - SCORE_DROP * result.unconfirmed);
    if (result.fired > 0 || result.checks > 0) stat.lastRun = run;
  }

  const gate: Gate | null = next.gate;
  const gated = (addedIn: number) => gate !== null && gate.passed && gate.version >= addedIn;
  let moved = false;
  const items = snapshot.items.map((i) => ({ ...i }));
  const agents = snapshot.agents.map((a) => ({ ...a }));

  const settle = (entry: KnowledgeItem | DynamicAgent, runsSeen: number, errored: boolean) => {
    if (entry.status === "retired" || entry.disabled) return;
    const stat = next.items[entry.id] ?? next.agents[entry.id];
    const retireIt = (why: string) => {
      entry.status = "retired";
      moved = true;
      notes.push(`retired ${entry.id}: ${why}`);
    };
    if (entry.pinned) return;
    if (!options.sourceIds.has(entry.source.id))
      return retireIt("its source is no longer on the list");
    if (entry.status === "candidate") {
      if (errored) return retireIt("it errored or left the scope in shadow");
      if (runsSeen >= config.limits.shadowRuns && gated(entry.addedInVersion)) {
        entry.status = "active";
        moved = true;
        notes.push(`promoted ${entry.id} to active`);
      }
      return;
    }
    if (stat && stat.score <= 0) return retireIt("its score reached zero");
    const idle = run - (stat?.lastRun ?? 0);
    if (idle >= config.limits.retireAfterRuns)
      retireIt(`it did not apply or fire for ${idle} runs`);
  };

  for (const item of items) settle(item, next.items[item.id]?.applied ?? 0, false);
  for (const agent of agents) {
    const stat = next.agents[agent.id];
    settle(agent, stat?.shadowRuns ?? 0, (stat?.errors ?? 0) > 0 || (stat?.outOfScope ?? 0) > 0);
  }

  return {
    next: moved
      ? {
          ...snapshot,
          version: snapshot.version + 1,
          createdAt: options.now.toISOString(),
          parent: snapshot.version,
          reason: `Lifecycle after run ${run}`,
          items,
          agents,
        }
      : null,
    stats: next,
    notes,
  };
}

/** Whether the regression gate accepts a synthetic-target run: nothing missing, nothing stray. */
export function gateFor(input: {
  version: number;
  runId: string;
  expected: number;
  found: number;
  stray: number;
  now: Date;
}): Gate {
  return {
    passed: input.found >= input.expected && input.stray === 0,
    version: input.version,
    runId: input.runId,
    recordedAt: input.now.toISOString(),
    found: input.found,
    expected: input.expected,
    stray: input.stray,
  };
}

/** The slice of a snapshot a run is given: entries in use, with their scores. */
export function pinLayer(snapshot: Snapshot, stats: LearningStats): PinnedLayer {
  return {
    version: snapshot.version,
    items: snapshot.items
      .filter((i) => i.status !== "retired" && !i.disabled)
      .map((i) => ({ ...i, score: stats.items[i.id]?.score ?? 1 })),
    agents: snapshot.agents
      .filter((a) => a.status !== "retired" && !a.disabled)
      .map((a) => ({ ...a, score: stats.agents[a.id]?.score ?? 1 })),
  };
}
