import { beforeEach, describe, expect, it } from "vitest";
import { useSession } from "../state/session.js";
import { ApiError, createHttpAuthApi, messageFor } from "./http.js";

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | undefined;
}

const reply = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = async (path: string, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? "GET",
      path,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body as string | undefined,
    };
    calls.push(call);
    return handler(call);
  };
  return { calls, fetchFn };
}

beforeEach(() => {
  useSession.getState().setUser({ email: "a@example.com", role: "customer" }, "csrf-1");
});

describe("http auth client", () => {
  it("posts JSON to the auth endpoints without retrying on 401", async () => {
    const { calls, fetchFn } = fakeFetch(() => reply(401, { error: "invalid_or_expired_code" }));
    const api = createHttpAuthApi(fetchFn);
    await expect(api.verifyCode("a@example.com", "123456")).rejects.toMatchObject({
      status: 401,
      code: "invalid_or_expired_code",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/auth/verify" });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ email: "a@example.com", code: "123456" });
  });

  it("sends the CSRF token on mutations but not on reads", async () => {
    const { calls, fetchFn } = fakeFetch(() => reply(200, { ok: true, authenticated: false }));
    const api = createHttpAuthApi(fetchFn);
    await api.logout();
    await api.getSession();
    expect(calls[0]!.headers["x-csrf-token"]).toBe("csrf-1");
    expect(calls[1]!.headers["x-csrf-token"]).toBeUndefined();
  });

  it("refreshes once on a 401 and retries the call", async () => {
    let meCalls = 0;
    const { calls, fetchFn } = fakeFetch((call) => {
      if (call.path === "/api/auth/refresh")
        return reply(200, {
          user: { email: "a@example.com", role: "customer" },
          csrfToken: "csrf-2",
        });
      return ++meCalls === 1 ? reply(401) : reply(200, { entitlements: { freeLiteReports: 1 } });
    });
    const account = await createHttpAuthApi(fetchFn).getAccount();
    expect(account).toEqual({ freeLiteRemaining: 1, paidCredits: 0 });
    expect(calls.map((c) => c.path)).toEqual(["/api/me", "/api/auth/refresh", "/api/me"]);
    expect(useSession.getState().csrfToken).toBe("csrf-2");
  });

  it("shares one refresh between concurrent calls (refresh tokens rotate)", async () => {
    const seen = new Set<string>();
    const { calls, fetchFn } = fakeFetch(async (call) => {
      if (call.path === "/api/auth/refresh") {
        await new Promise((r) => setTimeout(r, 10));
        return reply(200, { user: { email: "a@example.com", role: "customer" }, csrfToken: "c2" });
      }
      const first = !seen.has(call.path);
      seen.add(call.path);
      return first ? reply(401) : reply(200, { entitlements: { freeLiteReports: 0 } });
    });
    const api = createHttpAuthApi(fetchFn);
    await Promise.all([api.getAccount(), api.staffWhoami().catch(() => undefined)]);
    expect(calls.filter((c) => c.path === "/api/auth/refresh")).toHaveLength(1);
  });

  it("signs the page out when the refresh fails", async () => {
    const { fetchFn } = fakeFetch(() => reply(401, { error: "unauthenticated" }));
    await expect(createHttpAuthApi(fetchFn).getAccount()).rejects.toBeInstanceOf(ApiError);
    expect(useSession.getState().status).toBe("anonymous");
  });

  it("does not sign the page out for a 403", async () => {
    const { fetchFn } = fakeFetch(() => reply(403, { error: "forbidden" }));
    await expect(createHttpAuthApi(fetchFn).staffWhoami()).rejects.toMatchObject({ status: 403 });
    expect(useSession.getState().status).toBe("authenticated");
  });
});

describe("messageFor", () => {
  it("maps known codes and falls back otherwise", () => {
    expect(messageFor(new ApiError(429, "rate_limited"), "x")).toMatch(/too many/i);
    expect(messageFor(new ApiError(500, "weird"), "fallback")).toBe("fallback");
    expect(messageFor(new Error("boom"), "fallback")).toBe("fallback");
  });
});
