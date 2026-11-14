import { randomBytes } from "node:crypto";
import type { z } from "zod";
import {
  emptyStats,
  learningConfig,
  learningLogSchema,
  pointerSchema,
  snapshotSchema,
  statsSchema,
  type KnowledgeItem,
  type LearningLog,
  type LearningStats,
  type Pointer,
  type Snapshot,
} from "./schema.js";

/**
 * Where the dynamic layer lives in the data bucket (PLAN.md section 9):
 *
 *   learning/versions/<n>.json   immutable snapshots, created once (conditional create)
 *   learning/current.json        pointer to the active version, and the kill switch
 *   learning/stats.json          counters kept apart from the snapshots, so counting never makes a version
 *   learning/log/<ts>.json       every proposal with its decision and sources (never a run digest)
 *   learning/lock.json           one learner at a time
 *   learning/sources/<id>.json   fetched source text, cached
 *
 * Runs of the test accounts use `learning/test/` instead, so the real layer never learns from a
 * test target and a test can never change what a customer's run uses. Global: never per customer,
 * and untouched when a run or an account is deleted.
 */
export const LIVE_ROOT = "learning/";
export const TEST_ROOT = "learning/test/";
export const layerRoot = (test: boolean): string => (test ? TEST_ROOT : LIVE_ROOT);

/** The part of an object store the layer needs; the data bucket's store satisfies it. */
export interface LearningStorage {
  get(key: string): Promise<{ body: string; etag: string } | null>;
  put(
    key: string,
    body: string,
    condition?: { ifNoneMatch: true } | { ifMatch: string },
  ): Promise<{ etag: string }>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

const lost = (err: unknown) => (err as Error | undefined)?.name === "PreconditionFailedError";

const key = {
  version: (root: string, n: number) => `${root}versions/${n}.json`,
  versions: (root: string) => `${root}versions/`,
  pointer: (root: string) => `${root}current.json`,
  stats: (root: string) => `${root}stats.json`,
  lock: (root: string) => `${root}lock.json`,
  log: (root: string, at: Date) =>
    `${root}log/${at.toISOString().replaceAll(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}.json`,
  logs: (root: string) => `${root}log/`,
  source: (root: string, id: string) => `${root}sources/${id}.json`,
};
export const layerKeys = key;

async function readJson<S extends z.ZodType>(
  storage: LearningStorage,
  at: string,
  schema: S,
): Promise<{ value: z.infer<S>; etag: string } | null> {
  const found = await storage.get(at);
  return found ? { value: schema.parse(JSON.parse(found.body)), etag: found.etag } : null;
}

/** Writes only if the key is new; false when it already exists. */
async function createOnly(storage: LearningStorage, at: string, value: unknown): Promise<boolean> {
  try {
    await storage.put(at, JSON.stringify(value), { ifNoneMatch: true });
    return true;
  } catch (err) {
    if (lost(err)) return false;
    throw err;
  }
}

// The first version -----------------------------------------------------------------------------

const seedSource = (id: string, date: string) => {
  const source = learningConfig.sources.find((s) => s.id === id);
  return { id, name: source?.name ?? id, url: source?.url ?? "https://owasp.org/", date };
};

/** A handful of generic risk categories, so a fresh install has a layer that changes nothing a run does. */
export function seedSnapshot(now: Date): Snapshot {
  const date = now.toISOString().slice(0, 10);
  const top10 = seedSource("owasp-top10", date);
  const llm = seedSource("owasp-llm-top10", date);
  const item = (
    id: string,
    title: string,
    description: string,
    appliesTo: string[],
    source: KnowledgeItem["source"],
    severityHint: KnowledgeItem["severityHint"],
  ): KnowledgeItem => ({
    id,
    title,
    description,
    appliesTo,
    source,
    severityHint,
    status: "active",
    addedInVersion: 1,
  });
  return {
    version: 1,
    createdAt: now.toISOString(),
    parent: null,
    reason: "Seed: OWASP Top 10 and OWASP Top 10 for LLM applications categories",
    items: [
      item(
        "k-owasp-broken-access",
        "Broken access control",
        "Users reach data or functions their role should not allow: other users' records, administrative pages or API routes, and methods the interface never offers.",
        ["any"],
        top10,
        "high",
      ),
      item(
        "k-owasp-misconfiguration",
        "Security misconfiguration",
        "Missing security headers, verbose errors, exposed default pages or files, permissive cross-origin policy and unneeded features left on.",
        ["any"],
        top10,
        "medium",
      ),
      item(
        "k-owasp-supply-chain",
        "Software supply chain failures",
        "Outdated or compromised dependencies and scripts, and components served with known vulnerable versions.",
        ["any"],
        top10,
        "medium",
      ),
      item(
        "k-owasp-auth-failures",
        "Authentication failures",
        "Weak or guessable session identifiers, missing lockout, sessions that survive sign-out and tokens that never expire.",
        ["any"],
        top10,
        "high",
      ),
      item(
        "k-owasp-exceptional-conditions",
        "Mishandling of exceptional conditions",
        "Errors that reveal stack traces, internal paths or configuration, and failures that leave the application in an unsafe state.",
        ["any"],
        top10,
        "medium",
      ),
      item(
        "k-llm-prompt-injection",
        "Prompt injection",
        "Text a user or a document supplies changes what a language-model feature does, including ignoring its instructions or calling tools it should not.",
        ["llm", "ai"],
        llm,
        "high",
      ),
      item(
        "k-llm-output-handling",
        "Improper output handling",
        "Model output is rendered or used without validation, so it can inject markup, scripts or commands into the page or the systems behind it.",
        ["llm", "ai"],
        llm,
        "high",
      ),
      item(
        "k-llm-prompt-leakage",
        "System prompt leakage",
        "A language-model feature discloses its hidden instructions, which can expose rules, internal details or credentials placed in the prompt.",
        ["llm", "ai"],
        llm,
        "medium",
      ),
    ],
    agents: [],
  };
}

/** Creates version 1 and the pointer when the layer does not exist yet. Safe to call concurrently. */
export async function ensureSeed(storage: LearningStorage, root: string, now: Date): Promise<void> {
  if (await storage.get(key.pointer(root))) return;
  await createOnly(storage, key.version(root, 1), seedSnapshot(now));
  await createOnly(storage, key.pointer(root), {
    version: 1,
    enabled: true,
    updatedAt: now.toISOString(),
    by: "seed",
  } satisfies Pointer);
}

// Reading ---------------------------------------------------------------------------------------

export async function readPointer(storage: LearningStorage, root: string) {
  return readJson(storage, key.pointer(root), pointerSchema);
}

export async function readSnapshot(
  storage: LearningStorage,
  root: string,
  version: number,
): Promise<Snapshot | null> {
  return (await readJson(storage, key.version(root, version), snapshotSchema))?.value ?? null;
}

/** Every version number that exists, ascending. */
export async function listVersions(storage: LearningStorage, root: string): Promise<number[]> {
  const prefix = key.versions(root);
  return (await storage.list(prefix))
    .map((k) => /^(\d+)\.json$/.exec(k.slice(prefix.length))?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

export async function readStats(
  storage: LearningStorage,
  root: string,
): Promise<{ value: LearningStats; etag: string | null }> {
  const found = await readJson(storage, key.stats(root), statsSchema);
  return found ?? { value: emptyStats(), etag: null };
}

/** Compare-and-swap read-modify-write of the counters. `update` must be pure (it can be retried). */
export async function updateStats(
  storage: LearningStorage,
  root: string,
  update: (current: LearningStats) => LearningStats,
): Promise<LearningStats> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const { value, etag } = await readStats(storage, root);
    const next = update(value);
    try {
      await storage.put(
        key.stats(root),
        JSON.stringify(next),
        etag ? { ifMatch: etag } : { ifNoneMatch: true },
      );
      return next;
    } catch (err) {
      if (!lost(err)) throw err;
      await new Promise((r) => setTimeout(r, Math.random() * 20 * (attempt + 1)));
    }
  }
  throw new Error("Too much contention writing the learning stats");
}

export interface ActiveLayer {
  pointer: Pointer;
  snapshot: Snapshot;
  stats: LearningStats;
}

/** The layer runs use: creates the seed on first use; null when the kill switch is on or the layer is off in config. */
export async function readActive(
  storage: LearningStorage,
  root: string,
  now: Date,
): Promise<ActiveLayer | null> {
  if (!learningConfig.enabled) return null;
  await ensureSeed(storage, root, now);
  const pointer = (await readPointer(storage, root))?.value;
  if (!pointer?.enabled) return null;
  const snapshot = await readSnapshot(storage, root, pointer.version);
  if (!snapshot) return null;
  return { pointer, snapshot, stats: (await readStats(storage, root)).value };
}

// Writing ---------------------------------------------------------------------------------------

/**
 * Publishes a new version: the snapshot is created once (a parallel writer cannot overwrite it) and
 * the pointer moves to it only if it still points at the version the snapshot was built from. False
 * when either lost a race; the current version is then untouched.
 */
export async function commitVersion(
  storage: LearningStorage,
  root: string,
  snapshot: Snapshot,
  by: string,
): Promise<boolean> {
  const pointer = await readPointer(storage, root);
  if (!pointer || !pointer.value.enabled || pointer.value.version !== snapshot.parent) return false;
  if (!(await createOnly(storage, key.version(root, snapshot.version), snapshot))) return false;
  try {
    await storage.put(
      key.pointer(root),
      JSON.stringify({
        version: snapshot.version,
        enabled: true,
        updatedAt: snapshot.createdAt,
        by,
      } satisfies Pointer),
      { ifMatch: pointer.etag },
    );
    return true;
  } catch (err) {
    if (lost(err)) return false;
    throw err;
  }
}

/** Points runs at an existing version (rollback), or switches the layer off or on. */
export async function setPointer(
  storage: LearningStorage,
  root: string,
  change: { version?: number; enabled?: boolean; by: string; note?: string; now: Date },
): Promise<Pointer> {
  await ensureSeed(storage, root, change.now);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = (await readPointer(storage, root))!;
    const version = change.version ?? current.value.version;
    if (!(await readSnapshot(storage, root, version))) throw new Error(`No version ${version}`);
    const next: Pointer = {
      version,
      enabled: change.enabled ?? current.value.enabled,
      updatedAt: change.now.toISOString(),
      by: change.by,
      ...(change.note ? { note: change.note } : {}),
    };
    try {
      await storage.put(key.pointer(root), JSON.stringify(next), { ifMatch: current.etag });
      return next;
    } catch (err) {
      if (!lost(err)) throw err;
    }
  }
  throw new Error("Could not update the pointer: too much contention");
}

export async function appendLog(
  storage: LearningStorage,
  root: string,
  entry: LearningLog,
): Promise<void> {
  const checked = learningLogSchema.parse(entry);
  await storage.put(key.log(root, new Date(checked.at)), JSON.stringify(checked));
}

export async function readLogs(
  storage: LearningStorage,
  root: string,
  limit = 20,
): Promise<LearningLog[]> {
  const keys = (await storage.list(key.logs(root))).sort().slice(-limit);
  const logs: LearningLog[] = [];
  for (const k of keys) {
    const found = await readJson(storage, k, learningLogSchema);
    if (found) logs.push(found.value);
  }
  return logs;
}

// The lock --------------------------------------------------------------------------------------

const lockSchema = {
  parse: (v: unknown) => v as { holder: string; expiresAt: string },
};

/**
 * One learner at a time. A lock expires on its own (a learner that dies cannot block the next one
 * for longer than its own time limit). Returns false when another learner holds it.
 */
export async function acquireLock(
  storage: LearningStorage,
  root: string,
  holder: string,
  now: Date,
  seconds: number,
): Promise<boolean> {
  const lock = { holder, expiresAt: new Date(now.getTime() + seconds * 1000).toISOString() };
  const existing = await storage.get(key.lock(root));
  try {
    if (!existing) {
      await storage.put(key.lock(root), JSON.stringify(lock), { ifNoneMatch: true });
      return true;
    }
    const held = lockSchema.parse(JSON.parse(existing.body));
    if (Date.parse(held.expiresAt) > now.getTime()) return false;
    await storage.put(key.lock(root), JSON.stringify(lock), { ifMatch: existing.etag });
    return true;
  } catch (err) {
    if (lost(err)) return false;
    throw err;
  }
}

export async function releaseLock(
  storage: LearningStorage,
  root: string,
  holder: string,
): Promise<void> {
  const existing = await storage.get(key.lock(root));
  if (existing && lockSchema.parse(JSON.parse(existing.body)).holder === holder) {
    await storage.delete(key.lock(root));
  }
}

// Sources cache ----------------------------------------------------------------------------------

export interface CachedSource {
  id: string;
  url: string;
  fetchedAt: string;
  hash: string;
  text: string;
}

export async function readCachedSource(
  storage: LearningStorage,
  root: string,
  id: string,
): Promise<CachedSource | null> {
  const found = await storage.get(key.source(root, id));
  return found ? (JSON.parse(found.body) as CachedSource) : null;
}

export async function writeCachedSource(
  storage: LearningStorage,
  root: string,
  source: CachedSource,
): Promise<void> {
  await storage.put(key.source(root, source.id), JSON.stringify(source));
}
