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

/** The calls the real backend serves today: auth, session and account. */
export interface AuthApi {
  requestCode(email: string): Promise<{ sent: true }>;
  verifyCode(email: string, code: string): Promise<SignedIn>;
  verifyLink(token: string): Promise<SignedIn>;
  getSession(): Promise<SessionInfo>;
  logout(): Promise<void>;
  getAccount(): Promise<AccountInfo>;
  staffWhoami(): Promise<{ email: string; role: "staff" }>;
}

const MESSAGES: Record<string, string> = {
  invalid_email: "Enter a valid email address.",
  rate_limited: "Too many attempts. Please wait a while and try again.",
  invalid_or_expired_code: "That code is wrong or has expired. Request a new one.",
  verification_failed: "We could not verify that you are human. Try again.",
};

export const messageFor = (err: unknown, fallback: string): string =>
  err instanceof ApiError ? (MESSAGES[err.code] ?? fallback) : fallback;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Talks to /api (same origin). Cookies carry the session; a CSRF header goes on mutations. */
export function createHttpAuthApi(
  fetchFn: FetchLike = (input, init) => fetch(input, init),
): AuthApi {
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

  return {
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
      const me = await call<{ entitlements: { credits: AccountInfo["credits"] } }>(
        "GET",
        "/api/me",
      );
      return { credits: me.entitlements.credits };
    },
    staffWhoami: () => call("GET", "/api/staff/whoami"),
  };
}
