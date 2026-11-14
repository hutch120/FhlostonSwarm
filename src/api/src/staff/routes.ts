import {
  TIER_IDS,
  runIdSchema,
  scanIdSchema,
  scanStatusSchema,
  tierIdSchema,
  tiers,
  type StaffAccount,
  type StaffControls,
  type StaffRunRow,
  type StaffTierCaps,
  type TierId,
} from "@swarm/shared";
import { pricingSchema, type Pricing } from "@swarm/shared/server";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { deleteAccountData } from "../account.js";
import { readAudit, writeAudit } from "../audit.js";
import { stopRun, type ControlDeps } from "../control.js";
import { getLedger, getCredits } from "../credits.js";
import { grantComp, MAX_GRANT } from "../grant.js";
import { reject, readJson, type Vars } from "../http.js";
import { emailHash, parseEmail, testMarkerFor } from "../identity.js";
import {
  getActivePricing,
  getPricingVersion,
  listPricingVersions,
  savePricing,
} from "../pricing-store.js";
import { deleteRun, getRunFile, getRunInput, listRunFiles } from "../runs.js";
import { getScan, listScans, storedScanSchema } from "../scans.js";
import type { Secrets } from "../sessions.js";
import {
  applySettings,
  loadSettings,
  settingsDefaults,
  settingsPatchSchema,
  setKillSwitch,
  updateSettings,
} from "../settings.js";
import { updateJson } from "../storage/json.js";
import { keys } from "../storage/keys.js";
import type { ObjectStore } from "../storage/store.js";
import { getTarget } from "../targets.js";
import { getProfile } from "../users.js";
import { analyseCosts } from "./costs.js";
import { configuredModelIds, health, type MetricsReader } from "./health.js";
import {
  closedRow,
  findRunOwner,
  liveRow,
  recentRuns,
  runDetail,
  accountRuns,
  listAccountHashes,
} from "./runs.js";
import { readIndex, type IndexRecord } from "./index-records.js";
import { learningView, setEntryFlags, setLearningPointer } from "./learning.js";

export interface StaffDeps {
  store: ObjectStore;
  secrets: () => Promise<Secrets>;
  /** Stops runs and sends the notices staff trigger. */
  control: ControlDeps;
  metrics: MetricsReader | null;
  now: () => number;
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rangeQuery = z.object({
  from: day.optional(),
  to: day.optional(),
  /** `include` adds runs of test accounts, which are left out by default. */
  test: z.enum(["include", "only"]).optional(),
});
const runsQuery = rangeQuery.extend({
  tier: tierIdSchema.optional(),
  trigger: z.enum(["manual", "scheduled"]).optional(),
  entitlement: z.enum(["staff", "comp", "purchase", "credit"]).optional(),
  status: z.enum(["queued", "running", "complete", "stopped", "failed"]).optional(),
});
const costsQuery = rangeQuery.extend({
  /** A saved version to cost every run under; absent means each run as it was recorded. */
  pricing: z.string().min(1).max(60).optional(),
});

const DAY_MS = 86_400_000;
const MAX_ROWS = 500;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const grantBody = z.object({
  tier: tierIdSchema,
  count: z.number().int().min(1).max(MAX_GRANT),
  reason: z.string().trim().min(3).max(300),
});
const scanStatusBody = z.object({
  status: scanStatusSchema,
  reason: z.string().trim().max(300).optional(),
});
const deleteAccountBody = z.object({ reason: z.string().trim().min(3).max(300) });
const killSwitchBody = z.object({ on: z.boolean(), reason: z.string().trim().min(3).max(300) });
const pricingBody = z.object({
  table: pricingSchema,
  note: z.string().trim().max(300).default(""),
});
const previewBody = z.object({ table: pricingSchema }).extend(rangeQuery.shape);
const learningPointerBody = z.union([
  z.object({ version: z.number().int().positive() }).strict(),
  z.object({ enabled: z.boolean() }).strict(),
]);
const learningEntryBody = z.object({
  kind: z.enum(["item", "agent"]),
  id: z.string().min(3).max(60),
  pinned: z.boolean().optional(),
  disabled: z.boolean().optional(),
});

const capsOf = (l: StaffTierCaps): StaffTierCaps => ({
  pageCap: l.pageCap,
  llmStepCap: l.llmStepCap,
  stepCap: l.stepCap,
  requestCap: l.requestCap,
  requestsPerSecond: l.requestsPerSecond,
  tokenCap: l.tokenCap,
  spendCapUsd: l.spendCapUsd,
});
const capsByTier = (limits: Record<TierId, StaffTierCaps>) =>
  Object.fromEntries(TIER_IDS.map((t) => [t, capsOf(limits[t])])) as Record<TierId, StaffTierCaps>;

export async function controlsView(store: ObjectStore): Promise<StaffControls> {
  const stored = await loadSettings(store);
  const eff = applySettings(stored);
  return {
    killSwitch: {
      on: eff.killSwitch.on,
      reason: eff.killSwitch.reason,
      at: eff.killSwitch.at ?? null,
      by: eff.killSwitch.by ?? null,
    },
    concurrency: eff.concurrency,
    caps: capsByTier(eff.limits),
    dailySpendAlarmUsd: eff.dailySpendAlarmUsd,
    scheduledScans: eff.scheduledScans,
    blockedHosts: eff.blockedHosts,
    blockedEmailDomains: eff.blockedEmailDomains,
    defaults: {
      concurrency: settingsDefaults.concurrency,
      caps: capsByTier(settingsDefaults.limits),
      dailySpendAlarmUsd: settingsDefaults.dailySpendAlarmUsd,
      scheduledScans: settingsDefaults.scheduledScans,
    },
    updatedAt: stored?.updatedAt ?? null,
    updatedBy: stored?.updatedBy ?? null,
  };
}

/** Stops every run that is going or waiting, in every account (the kill switch). Returns how many. */
export async function stopEveryRun(control: ControlDeps, by: string): Promise<number> {
  let stopped = 0;
  for (const owner of await listAccountHashes(control.store)) {
    const active = (await listRunFiles(control.store, owner)).filter(
      (r) => r.status === "running" || r.status === "queued",
    );
    for (const run of active) {
      await stopRun(control, { emailHash: owner, runId: run.runId }, by, { cancelQueued: true });
      stopped += 1;
    }
  }
  return stopped;
}

/** The staff API (`/api/staff/*`). The caller has already been authenticated and checked as staff. */
export function staffRoutes(deps: StaffDeps) {
  const { store, now, control } = deps;
  const app = new Hono<{ Variables: Vars }>();
  const by = (c: Context<{ Variables: Vars }>) => c.get("auth").email;

  const query = <S extends z.ZodType>(c: Context, schema: S): z.infer<S> => {
    const parsed = schema.safeParse(c.req.query());
    return parsed.success ? parsed.data : (reject(400, "invalid_request") as never);
  };
  const range = (q: { from?: string | undefined; to?: string | undefined }) => {
    const to = q.to ?? isoDay(now());
    return { from: q.from ?? isoDay(Date.parse(to) - 30 * DAY_MS), to };
  };
  const keep = (test: boolean, mode: "include" | "only" | undefined) =>
    mode === "include" ? true : mode === "only" ? test : !test;
  const runIdParam = (c: Context): string => {
    const parsed = runIdSchema.safeParse(c.req.param("id"));
    return parsed.success ? parsed.data : (reject(404, "not_found") as never);
  };
  const hashParam = (c: Context): string => {
    const hash = c.req.param("hash") ?? "";
    return /^[0-9a-f]{64}$/.test(hash) ? hash : (reject(404, "not_found") as never);
  };

  app.get("/whoami", (c) => c.json({ email: c.get("auth").email, role: "staff" }));

  // Runs ------------------------------------------------------------------------------------

  app.get("/runs", async (c) => {
    const q = query(c, runsQuery);
    const { from, to } = range(q);
    const [records, live] = await Promise.all([
      readIndex(store, from, to),
      recentRuns(store, now(), 48 * 3_600_000),
    ]);
    const rows: StaffRunRow[] = [
      ...live
        .filter(({ file }) => file.status === "queued" || file.status === "running")
        .map(({ file }) => liveRow(file)),
      ...records.map(closedRow),
    ]
      .filter((r) => keep(r.test, q.test))
      .filter((r) => (q.tier ? r.tier === q.tier : true))
      .filter((r) => (q.trigger ? r.trigger === q.trigger : true))
      .filter((r) => (q.entitlement ? r.entitlement === q.entitlement : true))
      .filter((r) => (q.status ? r.status === q.status : true))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return c.json({ rows: rows.slice(0, MAX_ROWS), from, to, truncated: rows.length > MAX_ROWS });
  });

  app.get("/runs/:id", async (c) => {
    const runId = runIdParam(c);
    const owner = await findRunOwner(store, runId);
    const detail = owner ? await runDetail(store, owner, runId) : null;
    // A deleted run leaves only its anonymised record.
    const record = detail
      ? null
      : (await readIndex(store, "0000-00-00", "9999-99-99")).find((r) => r.runId === runId);
    if (!detail && !record) reject(404, "not_found");
    return c.json({ detail, row: record ? closedRow(record) : null });
  });

  const withRun = async (c: Context) => {
    const runId = runIdParam(c);
    const owner = (await findRunOwner(store, runId)) ?? reject(404, "not_found");
    const file = (await getRunFile(store, owner, runId)) ?? reject(404, "not_found");
    return { runId, owner, file };
  };

  app.post("/runs/:id/stop", async (c) => {
    const { runId, owner, file } = await withRun(c);
    if (file.status !== "running" && file.status !== "queued") reject(409, "not_running");
    const stopped = await stopRun(control, { emailHash: owner, runId }, `staff:${by(c)}`, {
      cancelQueued: true,
    });
    await writeAudit(store, now(), {
      ...(file.test ? { test: true as const } : {}),
      action: "stop-run",
      by: by(c),
      runId,
      accountHash: owner,
    });
    return c.json({ ok: true, status: stopped.status });
  });

  app.delete("/runs/:id", async (c) => {
    const { runId, owner, file } = await withRun(c);
    await stopRun(control, { emailHash: owner, runId }, `staff:${by(c)}`);
    await deleteRun(store, owner, runId);
    await writeAudit(store, now(), {
      ...(file.test ? { test: true as const } : {}),
      action: "delete-run",
      by: by(c),
      runId,
      accountHash: owner,
    });
    return c.json({ ok: true });
  });

  app.post("/runs/:id/resend-email", async (c) => {
    const { runId, owner, file } = await withRun(c);
    const input = await getRunInput(store, owner, runId);
    if (!input || (file.status !== "complete" && file.status !== "stopped"))
      reject(409, "not_finished");
    const { notify } = input!.scan;
    if (!notify.confirmed) reject(409, "notify_unconfirmed");
    try {
      await control.mailer.sendReportReady({
        to: notify.email,
        target: file.target,
        tierName: tiers[file.tier].name,
        status: file.status === "stopped" ? "stopped" : "complete",
        findings: file.findings.total,
        highOrAbove: file.findings.bySeverity.critical + file.findings.bySeverity.high,
        link: `${control.siteOrigin}/runs/${runId}/report`,
      });
    } catch (err) {
      console.error(JSON.stringify({ msg: "mail_failed", name: (err as Error).name }));
      return reject(503, "mail_failed");
    }
    await writeAudit(store, now(), {
      ...(file.test ? { test: true as const } : {}),
      action: "resend-report-email",
      by: by(c),
      runId,
      accountHash: owner,
    });
    return c.json({ ok: true });
  });

  // Costs and pricing -----------------------------------------------------------------------

  const analyse = async (q: z.infer<typeof rangeQuery>, table: Pricing | null) => {
    const { from, to } = range(q);
    const records = (await readIndex(store, from, to)).filter((r: IndexRecord) =>
      keep(r.test === true, q.test),
    );
    return analyseCosts(records, { from, to }, table);
  };

  app.get("/costs", async (c) => {
    const q = query(c, costsQuery);
    const table = q.pricing ? await getPricingVersion(store, q.pricing) : null;
    if (q.pricing && !table) reject(404, "unknown_pricing_version");
    return c.json(await analyse(q, table));
  });

  app.post("/costs/preview", async (c) => {
    const body = await readJson(c, previewBody);
    return c.json(await analyse(body, body.table));
  });

  app.get("/pricing", async (c) =>
    c.json({ active: await getActivePricing(store), versions: await listPricingVersions(store) }),
  );

  app.post("/pricing", async (c) => {
    const { table, note } = await readJson(c, pricingBody);
    if (!(await savePricing(store, table, note, by(c), now()))) reject(409, "version_exists");
    return c.json(
      { active: await getActivePricing(store), versions: await listPricingVersions(store) },
      201,
    );
  });

  // Users and support -----------------------------------------------------------------------

  const accountView = async (hash: string): Promise<StaffAccount | null> => {
    const [profile, ledger] = await Promise.all([getProfile(store, hash), getLedger(store, hash)]);
    if (!profile && !ledger) return null;
    const [credits, scans, runs, targetKeys] = await Promise.all([
      getCredits(store, hash),
      listScans(store, hash),
      accountRuns(store, hash),
      store.list(keys.targetsPrefix(hash)),
    ]);
    const hosts = new Map<string, string>();
    for (const scan of scans) {
      const target = await getTarget(store, hash, scan.targetId);
      hosts.set(scan.id, target?.hosts[0] ?? "(deleted target)");
    }
    return {
      accountHash: hash,
      email: profile?.email ?? "(no profile)",
      role: profile?.role ?? "customer",
      test: profile?.test === true || ledger?.test === true,
      createdAt: profile?.createdAt ?? 0,
      lastLoginAt: profile?.lastLoginAt ?? 0,
      credits,
      ledger: {
        granted: ledger?.granted ?? {
          comp: Object.fromEntries(TIER_IDS.map((t) => [t, 0])) as Record<TierId, number>,
          purchase: Object.fromEntries(TIER_IDS.map((t) => [t, 0])) as Record<TierId, number>,
        },
        consumed:
          ledger?.consumed ??
          (Object.fromEntries(TIER_IDS.map((t) => [t, 0])) as Record<TierId, number>),
        grants: ledger?.grants ?? [],
      },
      targets: targetKeys.filter((k) => k.endsWith(".json")).length,
      scans: scans.map((s) => ({
        id: s.id,
        name: s.name,
        tier: s.tier,
        frequency: s.schedule.frequency,
        status: s.status,
        notifyOn: s.notify.on,
        notifyConfirmed: s.notify.confirmed,
        target: hosts.get(s.id) ?? "",
      })),
      runs,
    };
  };

  app.get("/accounts", async (c) => {
    const { email } = query(c, z.object({ email: z.string().max(254) }));
    const parsed = parseEmail(email) ?? reject(400, "invalid_email");
    const { pepper } = await deps.secrets();
    const view = await accountView(emailHash(pepper, parsed!));
    if (!view) reject(404, "not_found");
    return c.json(view);
  });

  app.get("/accounts/:hash", async (c) => {
    const view = (await accountView(hashParam(c))) ?? reject(404, "not_found");
    return c.json(view);
  });

  app.post("/accounts/:hash/credits", async (c) => {
    const hash = hashParam(c);
    const profile = (await getProfile(store, hash)) ?? reject(404, "not_found");
    const body = await readJson(c, grantBody);
    const { pepper } = await deps.secrets();
    const credits = await grantComp(
      { store, pepper, by: by(c), now },
      { email: profile.email, ...body },
    );
    return c.json({ credits });
  });

  app.patch("/accounts/:hash/scans/:scanId/status", async (c) => {
    const hash = hashParam(c);
    const scanId = scanIdSchema.safeParse(c.req.param("scanId"));
    if (!scanId.success) reject(404, "not_found");
    const { status } = await readJson(c, scanStatusBody);
    const existing = (await getScan(store, hash, scanId.data!)) ?? reject(404, "not_found");
    await updateJson(store, keys.scan(hash, existing.id), storedScanSchema, (scan) =>
      scan ? { ...scan, status, updatedAt: now() } : undefined,
    );
    await writeAudit(store, now(), {
      ...(existing.test ? { test: true as const } : {}),
      action: "set-scan-status",
      by: by(c),
      accountHash: hash,
      scanId: existing.id,
      status,
    });
    return c.json({ ok: true, status });
  });

  app.delete("/accounts/:hash", async (c) => {
    const hash = hashParam(c);
    const profile = await getProfile(store, hash);
    if (!profile && !(await getLedger(store, hash))) reject(404, "not_found");
    const { reason } = await readJson(c, deleteAccountBody);
    for (const run of await listRunFiles(store, hash)) {
      if (run.status === "running" || run.status === "queued")
        await stopRun(control, { emailHash: hash, runId: run.runId }, `staff:${by(c)}`);
    }
    await deleteAccountData(store, hash);
    await writeAudit(store, now(), {
      ...(profile ? testMarkerFor(profile.email) : {}),
      action: "delete-account",
      by: by(c),
      accountHash: hash,
      reason,
    });
    if (profile) {
      try {
        await control.mailer.sendAccountDeleted({ to: profile.email });
      } catch (err) {
        console.error(JSON.stringify({ msg: "mail_failed", name: (err as Error).name }));
      }
    }
    return c.json({ ok: true });
  });

  // Controls --------------------------------------------------------------------------------

  app.get("/controls", async (c) => c.json(await controlsView(store)));

  app.put("/controls", async (c) => {
    const patch = await readJson(c, settingsPatchSchema);
    try {
      await updateSettings(store, patch, by(c), now());
    } catch (err) {
      if (err instanceof z.ZodError) return reject(400, "invalid_controls") as never;
      throw err;
    }
    return c.json(await controlsView(store));
  });

  app.post("/controls/kill-switch", async (c) => {
    const { on, reason } = await readJson(c, killSwitchBody);
    await setKillSwitch(store, on, reason, by(c), now());
    // Halting what is running is part of turning the switch on; turning it off only allows new runs.
    const stopped = on ? await stopEveryRun(control, `staff:${by(c)}`) : 0;
    return c.json({ controls: await controlsView(store), stopped });
  });

  app.get("/audit", async (c) => {
    const { limit } = query(
      c,
      z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
    );
    const records = await readAudit(store, limit);
    return c.json(
      records.map(({ at, action, by: who, ...detail }) => ({ at, action, by: who, detail })),
    );
  });

  // Health ----------------------------------------------------------------------------------

  app.get("/health", async (c) => {
    const eff = applySettings(await loadSettings(store));
    return c.json(await health(store, deps.metrics, configuredModelIds(eff.limits), now()));
  });

  // Learning layer --------------------------------------------------------------------------

  app.get("/learning", async (c) => c.json(await learningView(store, now())));

  app.post("/learning/pointer", async (c) => {
    const body = await readJson(c, learningPointerBody);
    try {
      await setLearningPointer(store, body, by(c), now());
    } catch (err) {
      if ((err as Error).message.startsWith("No version")) return reject(404, "not_found") as never;
      throw err;
    }
    return c.json(await learningView(store, now()));
  });

  app.post("/learning/entry", async (c) => {
    const body = await readJson(c, learningEntryBody);
    if (body.pinned === undefined && body.disabled === undefined) reject(400, "invalid_request");
    const outcome = await setEntryFlags(store, body, by(c), now());
    if (outcome === "not_found") reject(404, "not_found");
    if (outcome === "off") reject(409, "layer_off");
    if (outcome === "busy") reject(409, "busy");
    return c.json(await learningView(store, now()));
  });

  return app;
}
