import {
  TERMS_VERSION,
  isRecurring,
  reportFormatSchema,
  runIdSchema,
  runReportSchema,
  scanIdSchema,
  scanInputSchema,
  scanStatusSchema,
  targetIdSchema,
  targetInputSchema,
  type Frequency,
  type ScanStatus,
} from "@swarm/shared";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { deleteAccountData } from "./account.js";
import type { AuthConfig } from "./config.js";
import { startExecution, stopRun, stopRunningRuns, type ControlDeps } from "./control.js";
import { readEvents } from "./events.js";
import { clientIp, readJson, reject, type Vars } from "./http.js";
import { newId } from "./ids.js";
import { ipHash, parseEmail, testMarkerFor } from "./identity.js";
import type { RunLauncher } from "./launcher.js";
import { issueChallenge, verifyChallenge } from "./otp.js";
import { issueTestPasscode, testPasscodeLifetimeSchema } from "./testpass.js";
import {
  confirmNotification,
  revokeConfirmation,
  sendConfirmation,
  settleNotification,
  type NotifyDeps,
} from "./notify.js";
import { channelFor, type EventPublisher } from "./publisher.js";
import { hit } from "./ratelimit.js";
import { effectiveSettings, HOURS_BETWEEN, isBlockedDomain } from "./settings.js";
import {
  deleteRun,
  getRunFile,
  listRunFiles,
  startRun,
  toListItem,
  type RunOwner,
} from "./runs.js";
import {
  checkLoginsExist,
  getScan,
  listScans,
  storedScanSchema,
  viewScan,
  type LastRun,
  type StoredScan,
} from "./scans.js";
import { getJson, putJson, updateJson } from "./storage/json.js";
import { keys } from "./storage/keys.js";
import { mintStreamToken } from "./stream.js";
import {
  getTarget,
  listTargets,
  mergeLogins,
  scopeHosts,
  viewTarget,
  type StoredTarget,
} from "./targets.js";

/** Where the browser connects for live events (AppSync Events). Absent when there is no live channel (local dev). */
export interface StreamEndpoints {
  /** `<apiId>.appsync-realtime-api.<region>.amazonaws.com` */
  realtimeDomain: string;
  /** `<apiId>.appsync-api.<region>.amazonaws.com` */
  httpDomain: string;
}

export interface DataDeps extends NotifyDeps {
  config: AuthConfig;
  clearSessionCookies: (c: Context) => void;
  launcher: RunLauncher;
  publisher?: EventPublisher;
  /** A time-limited download URL for an object in the data bucket. */
  presign: (
    key: string,
    options: { filename: string; contentType: string; expiresSeconds: number },
  ) => Promise<string>;
  stream?: StreamEndpoints;
}

const statusBody = z.object({ status: scanStatusSchema });
const confirmBody = z.object({ token: z.string().min(20).max(100) });
const deleteBody = z.object({ code: z.string().regex(/^\d{4,10}$/) });
const testPasscodeBody = z.object({ lifetime: testPasscodeLifetimeSchema });

/** Targets, scans, runs, notification confirmation and account deletion (everything past sign-in). */
export function dataRoutes(deps: DataDeps) {
  const { store, config, intake, mailer, now } = deps;
  const app = new Hono<{ Variables: Vars }>();

  const owner = (c: Context<{ Variables: Vars }>): RunOwner => {
    const { emailHash, email, role } = c.get("auth");
    return { emailHash, email, role };
  };
  const idParam = (c: Context, schema: z.ZodType): string => {
    const parsed = schema.safeParse(c.req.param("id"));
    return parsed.success ? (parsed.data as string) : reject(404, "not_found");
  };
  const load = async (emailHash: string, scanId: string) => {
    const scan = (await getScan(store, emailHash, scanId)) ?? reject(404, "not_found");
    const target = (await getTarget(store, emailHash, scan.targetId)) ?? reject(404, "not_found");
    return { scan, target };
  };
  const count = async (prefix: string) =>
    (await store.list(prefix)).filter((key) => key.endsWith(".json")).length;
  /** The intake config with the hosts staff blocked added to the configured block list. */
  const currentIntake = async () => {
    const { blockedHosts } = await effectiveSettings(store);
    return blockedHosts.length === 0
      ? intake
      : {
          ...intake,
          blockedHosts: {
            ...intake.blockedHosts,
            domains: [...intake.blockedHosts.domains, ...blockedHosts],
          },
        };
  };
  /** The limits on repeating scans (staff change them in Controls): how many, and how often. */
  const checkSchedule = async (
    emailHash: string,
    frequency: Frequency,
    status: ScanStatus,
    exceptScanId?: string,
  ) => {
    if (frequency === "once" || status !== "active") return;
    const { scheduledScans } = await effectiveSettings(store);
    if (HOURS_BETWEEN[frequency] < scheduledScans.minSpacingHours)
      reject(409, "schedule_too_frequent");
    const active = (await listScans(store, emailHash)).filter(
      (s) => s.id !== exceptScanId && s.status === "active" && isRecurring(s.schedule.frequency),
    );
    if (active.length >= scheduledScans.maxActivePerAccount) reject(409, "scheduled_limit");
  };
  const checkNotifyDomain = async (address: string) => {
    const domain = parseEmail(address)?.domain;
    if (domain && isBlockedDomain(domain, (await effectiveSettings(store)).blockedEmailDomains))
      reject(400, "notify_email_blocked");
  };

  // Targets ---------------------------------------------------------------------------------

  app.get("/targets", async (c) => {
    const { emailHash } = c.get("auth");
    const [targets, scans] = await Promise.all([
      listTargets(store, emailHash),
      listScans(store, emailHash),
    ]);
    return c.json(
      targets
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((t) =>
          viewTarget(
            t,
            scans.filter((s) => s.targetId === t.id).map(({ id, name }) => ({ id, name })),
          ),
        ),
    );
  });

  app.post("/targets", async (c) => {
    const user = owner(c);
    const body = await readJson(c, targetInputSchema);
    const hosts = scopeHosts(body, await currentIntake(), user.role === "staff");
    if ((await count(keys.targetsPrefix(user.emailHash))) >= intake.quotas.maxTargets)
      reject(409, "quota_exceeded");
    const at = now();
    const target: StoredTarget = {
      ...testMarkerFor(user.email),
      id: newId("tgt", at),
      appUrl: body.appUrl,
      marketingUrl: body.marketingUrl,
      scopeNotes: body.scopeNotes,
      hosts,
      logins: mergeLogins(undefined, body.logins),
      acknowledgement: { at, ip: clientIp(c), termsVersion: TERMS_VERSION },
      createdAt: at,
      updatedAt: at,
    };
    await putJson(store, keys.target(user.emailHash, target.id), target);
    return c.json(viewTarget(target, []), 201);
  });

  app.put("/targets/:id", async (c) => {
    const user = owner(c);
    const id = idParam(c, targetIdSchema);
    const existing = (await getTarget(store, user.emailHash, id)) ?? reject(404, "not_found");
    const body = await readJson(c, targetInputSchema);
    const hosts = scopeHosts(body, await currentIntake(), user.role === "staff");
    const logins = mergeLogins(existing.logins, body.logins);
    const scans = (await listScans(store, user.emailHash)).filter((s) => s.targetId === id);
    // A login that a scan signs in with cannot be removed from under it.
    if (scans.some((s) => s.loginSlots.some((slot) => !logins[slot]))) reject(409, "login_in_use");
    const at = now();
    const next: StoredTarget = {
      ...existing,
      appUrl: body.appUrl,
      marketingUrl: body.marketingUrl,
      scopeNotes: body.scopeNotes,
      hosts,
      logins,
      acknowledgement: { at, ip: clientIp(c), termsVersion: TERMS_VERSION },
      updatedAt: at,
    };
    await putJson(store, keys.target(user.emailHash, id), next);
    return c.json(
      viewTarget(
        next,
        scans.map(({ id: scanId, name }) => ({ id: scanId, name })),
      ),
    );
  });

  app.delete("/targets/:id", async (c) => {
    const { emailHash } = owner(c);
    const id = idParam(c, targetIdSchema);
    if (!(await getTarget(store, emailHash, id))) reject(404, "not_found");
    const scans = (await listScans(store, emailHash)).filter((s) => s.targetId === id);
    for (const scan of scans) {
      await revokeConfirmation(store, scan.notify.pendingTokenHash);
      await store.delete(keys.scan(emailHash, scan.id));
    }
    await store.delete(keys.target(emailHash, id));
    return c.json({ ok: true, deletedScans: scans.map((s) => s.id) });
  });

  // Scans -----------------------------------------------------------------------------------

  const lastRuns = async (emailHash: string) => {
    const lastRun = new Map<string, LastRun>();
    for (const run of await listRunFiles(store, emailHash)) {
      if (!lastRun.has(run.scanId)) {
        lastRun.set(run.scanId, {
          scanId: run.scanId,
          runId: run.runId,
          status: run.status,
          startedAt: run.startedAt,
          ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
        });
      }
    }
    return lastRun;
  };

  app.get("/scans", async (c) => {
    const { emailHash } = c.get("auth");
    const [scans, targets, lastRun] = await Promise.all([
      listScans(store, emailHash),
      listTargets(store, emailHash),
      lastRuns(emailHash),
    ]);
    const byId = new Map(targets.map((t) => [t.id, t]));
    return c.json(
      scans
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((s) => viewScan(s, byId.get(s.targetId), lastRun.get(s.id))),
    );
  });

  const buildScan = (
    existing: StoredScan | null,
    input: z.infer<typeof scanInputSchema>,
    user: RunOwner,
  ): StoredScan => {
    const at = now();
    return {
      ...(existing ?? testMarkerFor(user.email)),
      id: existing?.id ?? newId("scan", at),
      targetId: input.targetId,
      name: input.name,
      tier: input.tier,
      schedule: { frequency: input.frequency, timezone: input.timezone },
      notify: {
        email: input.notifyEmail.trim().toLowerCase(),
        on: input.notifyOn,
        confirmed: existing?.notify.confirmed ?? false,
        pendingTokenHash: existing?.notify.pendingTokenHash ?? null,
      },
      loginSlots: input.loginSlots,
      status: existing?.status ?? "active",
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
  };

  const viewOne = async (emailHash: string, scan: StoredScan) => {
    const [target, lastRun] = await Promise.all([
      getTarget(store, emailHash, scan.targetId),
      lastRuns(emailHash),
    ]);
    return viewScan(scan, target ?? undefined, lastRun.get(scan.id));
  };

  app.post("/scans", async (c) => {
    const user = owner(c);
    const input = await readJson(c, scanInputSchema);
    const target =
      (await getTarget(store, user.emailHash, input.targetId)) ?? reject(404, "target_not_found");
    checkLoginsExist(input, target);
    await checkNotifyDomain(input.notifyEmail);
    await checkSchedule(user.emailHash, input.frequency, "active");
    if ((await count(keys.scansPrefix(user.emailHash))) >= intake.quotas.maxScans)
      reject(409, "quota_exceeded");
    const scan = await settleNotification(deps, user, buildScan(null, input, user), null);
    await putJson(store, keys.scan(user.emailHash, scan.id), scan);
    return c.json(await viewOne(user.emailHash, scan), 201);
  });

  app.get("/scans/:id", async (c) => {
    const user = owner(c);
    const scan =
      (await getScan(store, user.emailHash, idParam(c, scanIdSchema))) ?? reject(404, "not_found");
    return c.json(await viewOne(user.emailHash, scan));
  });

  app.put("/scans/:id", async (c) => {
    const user = owner(c);
    const existing =
      (await getScan(store, user.emailHash, idParam(c, scanIdSchema))) ?? reject(404, "not_found");
    const input = await readJson(c, scanInputSchema);
    const target =
      (await getTarget(store, user.emailHash, input.targetId)) ?? reject(404, "target_not_found");
    checkLoginsExist(input, target);
    await checkNotifyDomain(input.notifyEmail);
    await checkSchedule(user.emailHash, input.frequency, existing.status, existing.id);
    const scan = await settleNotification(deps, user, buildScan(existing, input, user), existing);
    await putJson(store, keys.scan(user.emailHash, scan.id), scan);
    return c.json(await viewOne(user.emailHash, scan));
  });

  app.patch("/scans/:id/status", async (c) => {
    const user = owner(c);
    const id = idParam(c, scanIdSchema);
    const { status } = await readJson(c, statusBody);
    const current = (await getScan(store, user.emailHash, id)) ?? reject(404, "not_found");
    await checkSchedule(user.emailHash, current.schedule.frequency, status, id);
    const updated = await updateJson(
      store,
      keys.scan(user.emailHash, id),
      storedScanSchema,
      (scan) => (scan ? { ...scan, status, updatedAt: now() } : undefined),
    );
    if (!updated) reject(404, "not_found");
    return c.json({ ok: true, status });
  });

  app.delete("/scans/:id", async (c) => {
    const { emailHash } = owner(c);
    const scan =
      (await getScan(store, emailHash, idParam(c, scanIdSchema))) ?? reject(404, "not_found");
    await revokeConfirmation(store, scan.notify.pendingTokenHash);
    await store.delete(keys.scan(emailHash, scan.id));
    return c.json({ ok: true });
  });

  app.post("/scans/:id/run", async (c) => {
    const user = owner(c);
    const { scan, target } = await load(user.emailHash, idParam(c, scanIdSchema));
    checkLoginsExist(scan, target);
    const runId = await startRun(store, user, scan, target, now());
    return c.json({ runId }, 201);
  });

  app.post("/scans/:id/notify/resend", async (c) => {
    const user = owner(c);
    const existing =
      (await getScan(store, user.emailHash, idParam(c, scanIdSchema))) ?? reject(404, "not_found");
    if (existing.notify.confirmed) return c.json({ ok: true, confirmed: true });
    // The old link stays valid unless a new one could be sent.
    const tokenHash = await sendConfirmation(deps, user, existing);
    if (!tokenHash) reject(429, "rate_limited");
    await revokeConfirmation(store, existing.notify.pendingTokenHash);
    await updateJson(store, keys.scan(user.emailHash, existing.id), storedScanSchema, (scan) =>
      scan ? { ...scan, notify: { ...scan.notify, pendingTokenHash: tokenHash } } : undefined,
    );
    return c.json({ ok: true, confirmed: false });
  });

  // Runs ------------------------------------------------------------------------------------

  app.get("/runs", async (c) => {
    const { emailHash } = c.get("auth");
    const [runs, scans] = await Promise.all([
      listRunFiles(store, emailHash),
      listScans(store, emailHash),
    ]);
    const scanIds = new Set(scans.map((s) => s.id));
    return c.json(runs.map((run) => toListItem(run, scanIds)));
  });

  app.get("/runs/:id", async (c) => {
    const { emailHash } = c.get("auth");
    const run =
      (await getRunFile(store, emailHash, idParam(c, runIdSchema))) ?? reject(404, "not_found");
    const scanIds = new Set((await listScans(store, emailHash)).map((s) => s.id));
    return c.json(toListItem(run, scanIds));
  });

  const control: ControlDeps = {
    store,
    launcher: deps.launcher,
    mailer,
    publisher: deps.publisher,
    now,
    siteOrigin: deps.siteOrigin,
  };

  app.post("/runs/:id/start", async (c) => {
    const { emailHash } = c.get("auth");
    const run = await startExecution(control, emailHash, idParam(c, runIdSchema));
    return c.json({ ok: true, status: run.status });
  });

  app.post("/runs/:id/stop", async (c) => {
    const { emailHash, role } = c.get("auth");
    const id = idParam(c, runIdSchema);
    const run = (await getRunFile(store, emailHash, id)) ?? reject(404, "not_found");
    if (run.status !== "running" && run.status !== "queued") reject(409, "not_running");
    const stopped = await stopRun(control, { emailHash, runId: id }, role, { cancelQueued: true });
    return c.json({ ok: true, status: stopped.status });
  });

  app.get("/runs/:id/events", async (c) => {
    const { emailHash } = c.get("auth");
    const id = idParam(c, runIdSchema);
    if (!(await getRunFile(store, emailHash, id))) reject(404, "not_found");
    const after = z.coerce.number().int().nonnegative().catch(0).parse(c.req.query("after"));
    return c.json(await readEvents(store, { emailHash, runId: id }, after));
  });

  app.post("/runs/:id/stream-token", async (c) => {
    const { emailHash } = c.get("auth");
    const id = idParam(c, runIdSchema);
    if (!(await getRunFile(store, emailHash, id))) reject(404, "not_found");
    if (!deps.stream) reject(404, "streaming_unavailable");
    const { realtimeDomain, httpDomain } = deps.stream!;
    const { token, expiresAt } = await mintStreamToken(
      await deps.secrets(),
      { runId: id, emailHash },
      now(),
    );
    return c.json({
      token,
      realtimeUrl: `wss://${realtimeDomain}/event/realtime`,
      host: httpDomain,
      channel: channelFor(id),
      expiresAt,
    });
  });

  app.get("/runs/:id/report", async (c) => {
    const { emailHash } = c.get("auth");
    const id = idParam(c, runIdSchema);
    const found = await getJson(store, keys.runReportData(emailHash, id), runReportSchema);
    if (!found) reject(404, "report_not_ready");
    return c.json(found!.value);
  });

  /** The report in one of its formats: the HTML, the PDF (rendered after the run closes) or the data as JSON. */
  const REPORT_FORMATS = {
    html: {
      key: keys.runReportHtml,
      contentType: "text/html; charset=utf-8",
    },
    pdf: { key: keys.runReportPdf, contentType: "application/pdf" },
    json: { key: keys.runReportData, contentType: "application/json" },
  } as const;

  app.get("/runs/:id/report/link", async (c) => {
    const { emailHash } = c.get("auth");
    const id = idParam(c, runIdSchema);
    const format = reportFormatSchema.parse(c.req.query("format") ?? "html");
    const { key: keyOf, contentType } = REPORT_FORMATS[format];
    const key = keyOf(emailHash, id);
    // The PDF arrives a little after the report; until it does, it is simply not ready.
    if (!(await store.list(key)).includes(key)) reject(404, "report_not_ready");
    const expiresSeconds = 300;
    const url = await deps.presign(key, {
      filename: `swarm-report-${id}.${format}`,
      contentType,
      expiresSeconds,
    });
    return c.json({ url, expiresAt: new Date(now() + expiresSeconds * 1000).toISOString() });
  });

  app.delete("/runs/:id", async (c) => {
    const { emailHash, role } = c.get("auth");
    const id = idParam(c, runIdSchema);
    if (!(await getRunFile(store, emailHash, id))) reject(404, "not_found");
    // A running run is stopped first, so no task keeps working on data that is being deleted.
    await stopRun(control, { emailHash, runId: id }, role);
    await deleteRun(store, emailHash, id);
    return c.json({ ok: true });
  });

  // Notification confirmation: the link goes to a mailbox that may not be signed in. --------

  app.post("/notify/confirm", async (c) => {
    const { token } = await readJson(c, confirmBody);
    const { pepper } = await deps.secrets();
    if (
      !(await hit(
        store,
        `ip-${ipHash(pepper, clientIp(c))}-verify`,
        config.rateLimits.verifyPerIpPerHour,
        now(),
      ))
    )
      reject(429, "rate_limited");
    if (!(await confirmNotification(deps, token))) reject(400, "invalid_or_expired_link");
    return c.json({ ok: true });
  });

  // Test passcode ---------------------------------------------------------------------------

  app.post("/account/test-passcode", async (c) => {
    const { emailHash, email } = c.get("auth");
    const { lifetime } = await readJson(c, testPasscodeBody);
    const { pepper } = await deps.secrets();
    if (
      !(await hit(
        store,
        `email-${emailHash}-testpass`,
        config.rateLimits.requestPerEmailPerHour,
        now(),
      ))
    )
      reject(429, "rate_limited");
    const issued = await issueTestPasscode(
      store,
      pepper,
      emailHash,
      email,
      lifetime,
      config,
      now(),
    );
    return c.json(issued);
  });

  // Account deletion ------------------------------------------------------------------------

  app.post("/account/delete-code", async (c) => {
    const { emailHash, email } = c.get("auth");
    const { pepper } = await deps.secrets();
    if (
      !(await hit(
        store,
        `email-${emailHash}-request`,
        config.rateLimits.requestPerEmailPerHour,
        now(),
      ))
    )
      reject(429, "rate_limited");
    const { code } = await issueChallenge(store, pepper, emailHash, email, config, now());
    try {
      await mailer.sendDeletionCode({ to: email, code, expiresMinutes: config.otp.ttlMinutes });
    } catch (err) {
      console.error(JSON.stringify({ msg: "mail_failed", name: (err as Error).name }));
    }
    return c.json({ ok: true });
  });

  app.delete("/account", async (c) => {
    const { emailHash, email } = c.get("auth");
    const { code } = await readJson(c, deleteBody);
    const { pepper } = await deps.secrets();
    if (
      !(await hit(
        store,
        `ip-${ipHash(pepper, clientIp(c))}-verify`,
        config.rateLimits.verifyPerIpPerHour,
        now(),
      ))
    )
      reject(429, "rate_limited");
    const outcome = await verifyChallenge(store, pepper, emailHash, { code }, config, now());
    if (!outcome.ok) reject(400, "invalid_or_expired_code");

    await stopRunningRuns(control, emailHash, "account-deletion");
    await deleteAccountData(store, emailHash);
    try {
      await mailer.sendAccountDeleted({ to: email });
    } catch (err) {
      console.error(JSON.stringify({ msg: "mail_failed", name: (err as Error).name }));
    }
    deps.clearSessionCookies(c);
    return c.json({ ok: true });
  });

  return app;
}
