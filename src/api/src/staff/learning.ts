import type { StaffLayerEntry, StaffLearning } from "@swarm/shared";
import {
  LIVE_ROOT,
  commitVersion,
  ensureSeed,
  learningConfig,
  listVersions,
  readLogs,
  readPointer,
  readSnapshot,
  setPointer,
  type Pointer,
  type Snapshot,
} from "@swarm/shared/server";
import { writeAudit } from "../audit.js";
import type { ObjectStore } from "../storage/store.js";

/**
 * Staff controls for the dynamic layer (PLAN.md section 9): see the versions and what each item and
 * agent is doing, roll back, turn the layer off and on, and pin or disable one entry. Every change is
 * a pointer flip or a new immutable version, and is audit-logged. Only the live layer is shown: the
 * test layer belongs to `swarm-test-` accounts.
 */

const entry = (x: {
  id: string;
  title: string;
  status: StaffLayerEntry["status"];
  pinned?: boolean | undefined;
  disabled?: boolean | undefined;
  source: { name: string };
}): StaffLayerEntry => ({
  id: x.id,
  title: x.title,
  status: x.status,
  pinned: x.pinned === true,
  disabled: x.disabled === true,
  source: x.source.name,
});

export async function learningView(store: ObjectStore, now: number): Promise<StaffLearning> {
  if (learningConfig.enabled) await ensureSeed(store, LIVE_ROOT, new Date(now));
  const pointer = (await readPointer(store, LIVE_ROOT))?.value ?? null;
  const snapshot = pointer ? await readSnapshot(store, LIVE_ROOT, pointer.version) : null;
  const versions = await Promise.all(
    (await listVersions(store, LIVE_ROOT)).map(async (n) => {
      const s = await readSnapshot(store, LIVE_ROOT, n);
      return s
        ? [
            {
              version: n,
              createdAt: s.createdAt,
              parent: s.parent,
              reason: s.reason,
              items: s.items.filter((i) => i.status !== "retired").length,
              agents: s.agents.filter((a) => a.status !== "retired").length,
            },
          ]
        : [];
    }),
  );
  return {
    enabled: learningConfig.enabled,
    killSwitchOn: pointer ? !pointer.enabled : false,
    version: pointer?.version ?? null,
    versions: versions.flat().reverse(),
    items: (snapshot?.items ?? []).map(entry),
    agents: (snapshot?.agents ?? []).map(entry),
    recent: (await readLogs(store, LIVE_ROOT, 8)).reverse().map((log) => ({
      at: log.at,
      outcome: log.outcome,
      toVersion: log.toVersion ?? null,
      model: log.model ?? null,
    })),
  };
}

/** Rolls runs back to a version, or turns the layer off (the kill switch) or on. */
export async function setLearningPointer(
  store: ObjectStore,
  change: { version?: number; enabled?: boolean },
  by: string,
  now: number,
): Promise<Pointer> {
  const note =
    change.version !== undefined
      ? `rollback to ${change.version}`
      : change.enabled === false
        ? "kill switch on"
        : "kill switch off";
  const pointer = await setPointer(store, LIVE_ROOT, { ...change, by, note, now: new Date(now) });
  await writeAudit(store, now, {
    action: "learning-pointer",
    by,
    version: pointer.version,
    enabled: pointer.enabled,
    note,
  });
  return pointer;
}

export type EntryFlags = {
  kind: "item" | "agent";
  id: string;
  pinned?: boolean;
  disabled?: boolean;
};

/** Pins or disables one entry by publishing a new version that differs from the current one only there. */
export async function setEntryFlags(
  store: ObjectStore,
  flags: EntryFlags,
  by: string,
  now: number,
): Promise<"done" | "not_found" | "busy" | "off"> {
  const pointer = (await readPointer(store, LIVE_ROOT))?.value;
  if (!pointer?.enabled) return "off";
  const current = await readSnapshot(store, LIVE_ROOT, pointer.version);
  if (!current) return "not_found";
  const list = flags.kind === "item" ? current.items : current.agents;
  if (!list.some((x) => x.id === flags.id)) return "not_found";
  const apply = <
    T extends { id: string; pinned?: boolean | undefined; disabled?: boolean | undefined },
  >(
    xs: T[],
  ) =>
    xs.map((x) =>
      x.id === flags.id
        ? {
            ...x,
            ...(flags.pinned !== undefined ? { pinned: flags.pinned } : {}),
            ...(flags.disabled !== undefined ? { disabled: flags.disabled } : {}),
          }
        : x,
    );
  const newest = Math.max(...(await listVersions(store, LIVE_ROOT)));
  const what = [
    flags.pinned !== undefined ? (flags.pinned ? "pin" : "unpin") : "",
    flags.disabled !== undefined ? (flags.disabled ? "disable" : "enable") : "",
  ]
    .filter(Boolean)
    .join(" and ");
  const next: Snapshot = {
    ...current,
    version: newest + 1,
    parent: pointer.version,
    createdAt: new Date(now).toISOString(),
    reason: `staff: ${what} ${flags.id}`,
    items: flags.kind === "item" ? apply(current.items) : current.items,
    agents: flags.kind === "agent" ? apply(current.agents) : current.agents,
  };
  if (!(await commitVersion(store, LIVE_ROOT, next, by))) return "busy";
  await writeAudit(store, now, { action: "learning-entry", by, ...flags, version: next.version });
  return "done";
}
