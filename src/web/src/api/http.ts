import type {
  ReportLink,
  RunEventsPage,
  RunListItem,
  RunReport,
  ScanStatus,
  ScanSummary,
  StreamToken,
  TargetView,
} from "@swarm/shared";
import { toScanInput, toTargetInput, type IntakeValues } from "../intake.js";
import { useSession, type SessionUser } from "../state/session.js";
import type { AccountInfo } from "./mock.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

export interface SessionInfo {
  authenticated: boolean;
  user?: SessionUser;
  csrfToken?: string;
}

export interface SignedIn {
  user: SessionUser;
  csrfToken: string;
}

export interface SavedScan {
  scanId: string;
  /** Set when the scan was also started. */
  runId?: string;
}

/** Everything the screens need from the backend. */
export interface ApiClient {
  requestCode(email: string): Promise<{ sent: true }>;
  verifyCode(email: string, code: string): Promise<SignedIn>;
  verifyLink(token: string): Promise<SignedIn>;
  getSession(): Promise<SessionInfo>;
  logout(): Promise<void>;
  getAccount(): Promise<AccountInfo>;
  staffWhoami(): Promise<{ email: string; role: "staff" }>;

  listRuns(): Promise<RunListItem[]>;
  getRun(runId: string): Promise<RunListItem>;
  deleteRun(runId: string): Promise<void>;
  /** Begins executing a queued run (a no-op error if it already started). */
  startRun(runId: string): Promise<void>;
  /** Stops a running run; the report covers what ran. */
  stopRun(runId: string): Promise<void>;
  /** Events after `after`, in order, for catch-up and polling. */
  getRunEvents(runId: string, after: number): Promise<RunEventsPage>;
  /** A short-lived credential for the live channel; fails with `streaming_unavailable` when there is none. */
  getStreamToken(runId: string): Promise<StreamToken>;
  getReport(runId: string): Promise<RunReport>;
  /** A time-limited download link for the report's HTML. */
  getReportLink(runId: string): Promise<ReportLink>;

  listTargets(): Promise<TargetView[]>;
  /** Deletes the target and the scans that use it; returns the ids of those scans. */
  deleteTarget(targetId: string): Promise<{ deletedScans: string[] }>;

  listScans(): Promise<ScanSummary[]>;
  /**
   * Saves the target and the scan (creating or updating each), and starts a run when `start` is
   * set. A new target is removed again if the scan cannot be saved.
   */
  saveScan(values: IntakeValues, options: { scanId?: string; start: boolean }): Promise<SavedScan>;
  /** Starts a new run from a saved scan, with no reconfiguration, and begins executing it. */
  runScan(scanId: string): Promise<{ runId: string }>;
  setScanStatus(scanId: string, status: ScanStatus): Promise<void>;
  deleteScan(scanId: string): Promise<void>;
  resendNotifyConfirmation(scanId: string): Promise<void>;
  /** Follows a notification-address confirmation link. */
  confirmNotify(token: string): Promise<void>;

  /** Emails a fresh code that confirms deleting the account. */
  requestAccountDeletion(): Promise<void>;
  deleteAccount(code: string): Promise<void>;
}

const URL_PROBLEMS: Record<string, string> = {
  invalid_url: "Enter a full URL starting with https:// (or http://).",
  credentials_in_url: "Remove the username and password from the URL. Add logins below instead.",
  private_address: "That address is private or reserved. Enter a public staging hostname.",
  unroutable_host: "That name only works inside a private network. Enter a public hostname.",
  blocked_host: "We cannot scan that host. It is on our blocked list.",
};

const MESSAGES: Record<string, string> = {
  invalid_email: "Enter a valid email address.",
  rate_limited: "Too many attempts. Please wait a while and try again.",
  invalid_or_expired_code: "That code is wrong or has expired. Request a new one.",
  invalid_or_expired_link: "That link has expired or was already used.",
  verification_failed: "We could not verify that you are human. Try again.",
  no_credit: "You have no credit for that scan depth.",
  already_started: "That run has already started.",
  not_running: "That run is not running.",
  start_failed: "The run could not be started. Try again in a moment.",
  report_not_ready: "The report is not ready yet.",
  streaming_unavailable: "Live updates are not available.",
  quota_exceeded: "You have reached the limit for saved items. Delete some you no longer need.",
  password_required: "Enter a password for each new login.",
  login_in_use: "A scan uses a login you removed. Edit or delete that scan first.",
  login_missing: "That scan uses a login the target does not have.",
  not_found: "That no longer exists.",
  busy: "The service is busy. Try again in a moment.",
  ...Object.fromEntries(
    Object.entries(URL_PROBLEMS).flatMap(([problem, text]) => [
      [`app_url_${problem}`, text],
      [`marketing_url_${problem}`, text],
    ]),
  ),
};

export const messageFor = (err: unknown, fallback: string): string =>
  err instanceof ApiError ? (MESSAGES[err.code] ?? fallback) : fallback;

/** The intake field an API error code belongs to, if it names one. */
export const fieldForError = (err: unknown): "appUrl" | "marketingUrl" | null =>
  err instanceof ApiError
    ? err.code.startsWith("app_url_")
      ? "appUrl"
      : err.code.startsWith("marketing_url_")
        ? "marketingUrl"
        : null
    : null;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Talks to /api (same origin). Cookies carry the session; a CSRF header goes on mutations. */
export function createHttpApi(fetchFn: FetchLike = (input, init) => fetch(input, init)): ApiClient {
  let refreshing: Promise<boolean> | null = null;

  const send = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const csrf = useSession.getState().csrfToken;
    return fetchFn(path, {
      method,
      credentials: "same-origin",
      headers: {
        ...(method !== "GET" ? { "content-type": "application/json" } : {}),
        ...(method !== "GET" && csrf ? { "x-csrf-token": csrf } : {}),
      },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
  };

  // One refresh at a time: refresh tokens rotate, so concurrent refreshes would revoke the session.
  const refresh = (): Promise<boolean> =>
    (refreshing ??= (async () => {
      try {
        const res = await send("POST", "/api/auth/refresh");
        if (!res.ok) return false;
        const data = (await res.json()) as SignedIn;
        useSession.getState().setUser(data.user, data.csrfToken);
        return true;
      } finally {
        refreshing = null;
      }
    })());

  const call = async <T>(
    method: string,
    path: string,
    body?: unknown,
    { retry = true }: { retry?: boolean } = {},
  ): Promise<T> => {
    let res = await send(method, path, body);
    if (res.status === 401 && retry && (await refresh())) res = await send(method, path, body);
    if (res.status === 401 && retry) useSession.getState().setAnonymous();
    const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
    if (!res.ok) throw new ApiError(res.status, data.error ?? "request_failed");
    return data;
  };

  const id = encodeURIComponent;

  const api: ApiClient = {
    requestCode: async (email) => {
      await call("POST", "/api/auth/request", { email }, { retry: false });
      return { sent: true };
    },
    verifyCode: (email, code) =>
      call("POST", "/api/auth/verify", { email, code }, { retry: false }),
    verifyLink: (token) => call("POST", "/api/auth/verify", { token }, { retry: false }),
    getSession: () => call("GET", "/api/auth/session", undefined, { retry: false }),
    logout: async () => {
      await call("POST", "/api/auth/logout", {}, { retry: false });
    },
    getAccount: async () => {
      const me = await call<{ entitlements: AccountInfo }>("GET", "/api/me");
      return { credits: me.entitlements.credits, unmetered: me.entitlements.unmetered };
    },
    staffWhoami: () => call("GET", "/api/staff/whoami"),

    listRuns: () => call("GET", "/api/runs"),
    getRun: (runId) => call("GET", `/api/runs/${id(runId)}`),
    deleteRun: async (runId) => {
      await call("DELETE", `/api/runs/${id(runId)}`);
    },
    startRun: async (runId) => {
      await call("POST", `/api/runs/${id(runId)}/start`);
    },
    stopRun: async (runId) => {
      await call("POST", `/api/runs/${id(runId)}/stop`);
    },
    getRunEvents: (runId, after) => call("GET", `/api/runs/${id(runId)}/events?after=${after}`),
    getStreamToken: (runId) => call("POST", `/api/runs/${id(runId)}/stream-token`),
    getReport: (runId) => call("GET", `/api/runs/${id(runId)}/report`),
    getReportLink: (runId) => call("GET", `/api/runs/${id(runId)}/report/link`),

    listTargets: () => call("GET", "/api/targets"),
    deleteTarget: (targetId) => call("DELETE", `/api/targets/${id(targetId)}`),

    listScans: () => call("GET", "/api/scans"),
    saveScan: async (values, { scanId, start }) => {
      const targetBody = toTargetInput(values);
      const target = values.targetId
        ? await call<TargetView>("PUT", `/api/targets/${id(values.targetId)}`, targetBody)
        : await call<TargetView>("POST", "/api/targets", targetBody);
      let scan: ScanSummary;
      try {
        const scanBody = toScanInput(values, target.id, useSession.getState().email ?? "");
        scan = scanId
          ? await call<ScanSummary>("PUT", `/api/scans/${id(scanId)}`, scanBody)
          : await call<ScanSummary>("POST", "/api/scans", scanBody);
      } catch (err) {
        if (!values.targetId) await api.deleteTarget(target.id).catch(() => undefined);
        throw err;
      }
      if (!start) return { scanId: scan.id };
      const { runId } = await api.runScan(scan.id);
      return { scanId: scan.id, runId };
    },
    runScan: async (scanId) => {
      const { runId } = await call<{ runId: string }>("POST", `/api/scans/${id(scanId)}/run`);
      // A run that could not be started stays queued; its page offers to start it.
      await call("POST", `/api/runs/${id(runId)}/start`).catch(() => undefined);
      return { runId };
    },
    setScanStatus: async (scanId, status) => {
      await call("PATCH", `/api/scans/${id(scanId)}/status`, { status });
    },
    deleteScan: async (scanId) => {
      await call("DELETE", `/api/scans/${id(scanId)}`);
    },
    resendNotifyConfirmation: async (scanId) => {
      await call("POST", `/api/scans/${id(scanId)}/notify/resend`);
    },
    confirmNotify: async (token) => {
      await call("POST", "/api/notify/confirm", { token }, { retry: false });
    },

    requestAccountDeletion: async () => {
      await call("POST", "/api/account/delete-code");
    },
    deleteAccount: async (code) => {
      await call("DELETE", "/api/account", { code });
    },
  };
  return api;
}
