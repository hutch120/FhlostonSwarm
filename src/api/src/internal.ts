import { eventBatchSchema, runIdSchema, summarise, type RunState } from "@swarm/shared";
import { agentInputSchema } from "@swarm/shared/server";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError, z } from "zod";
import { appendEvents } from "./events.js";
import { reject } from "./http.js";
import { pinDynamic } from "./learning.js";
import type { EventPublisher } from "./publisher.js";
import { checkRunToken } from "./runtoken.js";
import {
  buildAgentInput,
  getRunFile,
  getRunInput,
  isTerminal,
  runFileSchema,
  type RunFile,
} from "./runs.js";
import type { Secrets } from "./sessions.js";
import { ContentionError, putJson, updateJson } from "./storage/json.js";
import { keys } from "./storage/keys.js";
import type { ObjectStore } from "./storage/store.js";

export interface InternalDeps {
  store: ObjectStore;
  secrets: () => Promise<Secrets>;
  publisher?: EventPublisher;
  now: () => number;
  /** Require API Gateway to have authenticated the caller with IAM (always on in Lambda). */
  requireIam: boolean;
}

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PDF_BODY_BYTES = 4 * 1024 * 1024;
/** Routes that need a closed run (the others need a running one). */
const AFTER_RUN_ROUTES = new Set(["/api/internal/report", "/api/internal/report-pdf"]);
const pdfBody = z.object({ pdf: z.string().min(16) });
const EVIDENCE_NAMES = [
  "proxy-log",
  "proxy-stats",
  "app-profile",
  "usage",
  "explorer-log",
  "engagement",
  "dynamic-results",
] as const;
const evidenceBody = z.object({
  name: z.enum(EVIDENCE_NAMES),
  body: z.record(z.string(), z.unknown()),
});

interface Vars {
  emailHash: string;
  runId: string;
  run: RunFile;
}

/** Folds the run state into the summary the dashboard lists, while the run is still going. */
async function recordProgress(
  store: ObjectStore,
  emailHash: string,
  runId: string,
  run: RunState,
  now: number,
) {
  const progress = summarise(run);
  await updateJson(store, keys.runSummary(emailHash, runId), runFileSchema, (current) =>
    current && current.status === "running"
      ? {
          ...current,
          checks: progress.checks,
          requests: progress.requests,
          coverage: progress.coverage,
          findings: progress.findings,
          gaps: progress.gaps,
          agents: progress.agents,
          durationMs: Math.max(0, now - Date.parse(current.startedAt)),
        }
      : undefined,
  );
}

/**
 * The agent tasks' API (`/api/internal/*`). API Gateway authenticates the caller with IAM (the task
 * role); this layer additionally checks the run token, so a task can only touch its own run, and that
 * the run is still running, so a stopped or finished run takes no more events.
 */
export function internalApp(deps: InternalDeps) {
  const { store } = deps;
  const app = new Hono<{ Variables: Vars }>().basePath("/api/internal");

  app.onError((err, c) => {
    if (err instanceof ZodError) return c.json({ error: "invalid_request" }, 400);
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    if (err instanceof ContentionError) return c.json({ error: "busy" }, 503);
    console.error(JSON.stringify({ msg: "internal_error", name: err.name }));
    return c.json({ error: "internal_error" }, 500);
  });

  app.use(async (c: Context<{ Variables: Vars }>, next) => {
    if (deps.requireIam) {
      const env = c.env as { event?: { requestContext?: { authorizer?: { iam?: unknown } } } };
      if (!env?.event?.requestContext?.authorizer?.iam) return c.json({ error: "forbidden" }, 403);
    }
    const emailHash = c.req.header("x-swarm-owner") ?? "";
    const runId = c.req.header("x-swarm-run") ?? "";
    if (!/^[0-9a-f]{64}$/.test(emailHash) || !runIdSchema.safeParse(runId).success)
      return c.json({ error: "forbidden" }, 403);
    if (!checkRunToken(await deps.secrets(), emailHash, runId, c.req.header("x-swarm-token")))
      return c.json({ error: "forbidden" }, 403);
    const run = await getRunFile(store, emailHash, runId);
    if (!run) return c.json({ error: "not_found" }, 404);
    // Events and evidence only while the run is going; the report routes only once it has closed.
    const afterRun = AFTER_RUN_ROUTES.has(c.req.path);
    if (afterRun ? !isTerminal(run.status) : run.status !== "running") {
      return c.json({ error: afterRun ? "run_not_finished" : "run_not_running" }, 409);
    }
    c.set("emailHash", emailHash);
    c.set("runId", runId);
    c.set("run", run);
    await next();
  });

  const body = async (c: Context, limit = MAX_BODY_BYTES): Promise<unknown> => {
    const text = await c.req.text();
    if (text.length > limit) return reject(400, "too_large") as never;
    try {
      return JSON.parse(text);
    } catch {
      return reject(400, "invalid_request") as never;
    }
  };

  app.get("/input", async (c) => {
    const input = await getRunInput(store, c.get("emailHash"), c.get("runId"));
    if (!input) return c.json({ error: "not_found" }, 404);
    const dynamic = await pinDynamic(
      store,
      c.get("emailHash"),
      c.get("runId"),
      c.get("run").test === true,
      deps.now(),
    );
    return c.json(agentInputSchema.parse({ ...buildAgentInput(input), dynamic }));
  });

  app.post("/events", async (c) => {
    const emailHash = c.get("emailHash");
    const runId = c.get("runId");
    const run = c.get("run");
    const batch = eventBatchSchema.parse(await body(c));
    const appended = await appendEvents(
      store,
      { emailHash, runId, tier: run.tier, test: run.test },
      batch,
      deps.publisher,
    );
    await recordProgress(store, emailHash, runId, appended.run, deps.now());
    return c.json({ lastSeq: appended.lastSeq, duplicate: appended.duplicate });
  });

  app.post("/evidence", async (c) => {
    const { name, body: value } = evidenceBody.parse(await body(c));
    const run = c.get("run");
    await putJson(store, keys.runEvidence(c.get("emailHash"), c.get("runId"), name), {
      ...(run.test ? { test: true } : {}),
      ...value,
    });
    return c.json({ ok: true });
  });

  // The PDF step: a task of the same image reads the finished report, renders it with a headless
  // browser and hands the PDF back. Only once the run has closed (see the middleware).
  app.get("/report", async (c) => {
    const found = await store.get(keys.runReportHtml(c.get("emailHash"), c.get("runId")));
    if (!found) return c.json({ error: "not_found" }, 404);
    return c.json({ html: found.body });
  });

  app.post("/report-pdf", async (c) => {
    const { pdf } = pdfBody.parse(await body(c, MAX_PDF_BODY_BYTES));
    const bytes = Buffer.from(pdf, "base64");
    if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return reject(400, "invalid_request");
    await store.putBytes(
      keys.runReportPdf(c.get("emailHash"), c.get("runId")),
      bytes,
      "application/pdf",
    );
    return c.json({ ok: true });
  });

  return app;
}
