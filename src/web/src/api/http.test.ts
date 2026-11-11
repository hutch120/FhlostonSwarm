import { beforeEach, describe, expect, it } from "vitest";
import { emptyIntake, type IntakeValues } from "../intake.js";
import { useSession } from "../state/session.js";
import { ApiError, createHttpApi, fieldForError, messageFor } from "./http.js";

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
    const api = createHttpApi(fetchFn);
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
    const api = createHttpApi(fetchFn);
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
      return ++meCalls === 1
        ? reply(401)
        : reply(200, {
            entitlements: { credits: { scout: 2, sweep: 0, probe: 0, siege: 1 }, unmetered: false },
          });
    });
    const account = await createHttpApi(fetchFn).getAccount();
    expect(account).toEqual({
      credits: { scout: 2, sweep: 0, probe: 0, siege: 1 },
      unmetered: false,
    });
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
      return first ? reply(401) : reply(200, { entitlements: { credits: {} } });
    });
    const api = createHttpApi(fetchFn);
    await Promise.all([api.getAccount(), api.staffWhoami().catch(() => undefined)]);
    expect(calls.filter((c) => c.path === "/api/auth/refresh")).toHaveLength(1);
  });

  it("signs the page out when the refresh fails", async () => {
    const { fetchFn } = fakeFetch(() => reply(401, { error: "unauthenticated" }));
    await expect(createHttpApi(fetchFn).getAccount()).rejects.toBeInstanceOf(ApiError);
    expect(useSession.getState().status).toBe("anonymous");
  });

  it("does not sign the page out for a 403", async () => {
    const { fetchFn } = fakeFetch(() => reply(403, { error: "forbidden" }));
    await expect(createHttpApi(fetchFn).staffWhoami()).rejects.toMatchObject({ status: 403 });
    expect(useSession.getState().status).toBe("authenticated");
  });
});

describe("messageFor", () => {
  it("maps known codes and falls back otherwise", () => {
    expect(messageFor(new ApiError(429, "rate_limited"), "x")).toMatch(/too many/i);
    expect(messageFor(new ApiError(402, "no_credit"), "x")).toMatch(/no credit/i);
    expect(messageFor(new ApiError(400, "app_url_private_address"), "x")).toMatch(/private/i);
    expect(messageFor(new ApiError(400, "marketing_url_blocked_host"), "x")).toMatch(/blocked/i);
    expect(messageFor(new ApiError(500, "weird"), "fallback")).toBe("fallback");
    expect(messageFor(new Error("boom"), "fallback")).toBe("fallback");
  });

  it("says which intake field a URL error belongs to", () => {
    expect(fieldForError(new ApiError(400, "app_url_invalid_url"))).toBe("appUrl");
    expect(fieldForError(new ApiError(400, "marketing_url_blocked_host"))).toBe("marketingUrl");
    expect(fieldForError(new ApiError(402, "no_credit"))).toBeNull();
    expect(fieldForError(new Error("x"))).toBeNull();
  });
});

describe("saving a scan", () => {
  const values = (over: Partial<IntakeValues> = {}): IntakeValues => {
    const v = emptyIntake("a@example.com");
    v.appUrl = "https://staging.example.com";
    v.acknowledged = true;
    v.logins.user1 = {
      username: "u",
      password: "p",
      description: "Standard",
      notes: "",
      use: true,
      saved: false,
    };
    return { ...v, ...over };
  };

  const server = (failScan = false) => {
    const created: string[] = [];
    return fakeFetch((call) => {
      created.push(`${call.method} ${call.path}`);
      if (call.path === "/api/targets" && call.method === "POST")
        return reply(201, { id: "tgt_abcd1234" });
      if (call.path.startsWith("/api/targets/") && call.method === "PUT")
        return reply(200, { id: "tgt_abcd1234" });
      if (call.path.startsWith("/api/targets/") && call.method === "DELETE")
        return reply(200, { ok: true, deletedScans: [] });
      if (call.path.startsWith("/api/scans") && call.path.endsWith("/run"))
        return reply(201, { runId: "run_abcd1234" });
      return failScan
        ? reply(409, { error: "quota_exceeded" })
        : reply(201, { id: "scan_abcd1234" });
      return reply(404);
    });
  };

  it("creates the target, then the scan, then starts the run", async () => {
    const { calls, fetchFn } = server();
    const saved = await createHttpApi(fetchFn).saveScan(values(), { start: true });
    expect(saved).toEqual({ scanId: "scan_abcd1234", runId: "run_abcd1234" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/targets",
      "POST /api/scans",
      "POST /api/scans/scan_abcd1234/run",
      "POST /api/runs/run_abcd1234/start",
    ]);
    const [targetBody, scanBody] = [JSON.parse(calls[0]!.body!), JSON.parse(calls[1]!.body!)];
    expect(targetBody.logins.user1.password).toBe("p");
    expect(scanBody).toMatchObject({
      targetId: "tgt_abcd1234",
      tier: "sweep",
      loginSlots: ["user1"],
    });
  });

  it("without a credit it only saves, and an existing target and scan are updated", async () => {
    const { calls, fetchFn } = server();
    const saved = await createHttpApi(fetchFn).saveScan(values({ targetId: "tgt_abcd1234" }), {
      scanId: "scan_abcd1234",
      start: false,
    });
    expect(saved).toEqual({ scanId: "scan_abcd1234" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PUT /api/targets/tgt_abcd1234",
      "PUT /api/scans/scan_abcd1234",
    ]);
  });

  it("removes a target it just created if the scan cannot be saved, but never an existing one", async () => {
    const fresh = server(true);
    await expect(
      createHttpApi(fresh.fetchFn).saveScan(values(), { start: true }),
    ).rejects.toMatchObject({ code: "quota_exceeded" });
    expect(fresh.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/targets",
      "POST /api/scans",
      "DELETE /api/targets/tgt_abcd1234",
    ]);
    const existing = server(true);
    await expect(
      createHttpApi(existing.fetchFn).saveScan(values({ targetId: "tgt_abcd1234" }), {
        start: true,
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(existing.calls.map((c) => c.method)).toEqual(["PUT", "POST"]);
  });
});

describe("run calls", () => {
  it("starts a run after creating it, and leaves it queued when it cannot be started", async () => {
    const { calls, fetchFn } = fakeFetch((call) =>
      call.path.endsWith("/start")
        ? reply(503, { error: "start_failed" })
        : reply(201, { runId: "run_abcd1234" }),
    );
    expect(await createHttpApi(fetchFn).runScan("scan_abcd1234")).toEqual({
      runId: "run_abcd1234",
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/scans/scan_abcd1234/run",
      "POST /api/runs/run_abcd1234/start",
    ]);
  });

  it("starts and stops a run, and reads its events, stream token, report and download link", async () => {
    const { calls, fetchFn } = fakeFetch(() => reply(200, { ok: true }));
    const api = createHttpApi(fetchFn);
    await api.startRun("run_abcd1234");
    await api.stopRun("run_abcd1234");
    await api.getRunEvents("run_abcd1234", 17);
    await api.getStreamToken("run_abcd1234");
    await api.getReport("run_abcd1234");
    await api.getReportLink("run_abcd1234", "pdf");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/runs/run_abcd1234/start",
      "POST /api/runs/run_abcd1234/stop",
      "GET /api/runs/run_abcd1234/events?after=17",
      "POST /api/runs/run_abcd1234/stream-token",
      "GET /api/runs/run_abcd1234/report",
      "GET /api/runs/run_abcd1234/report/link?format=pdf",
    ]);
    // Only the mutations carry the CSRF token.
    expect(calls.map((c) => c.headers["x-csrf-token"])).toEqual([
      "csrf-1",
      "csrf-1",
      undefined,
      "csrf-1",
      undefined,
      undefined,
    ]);
  });

  it("explains the run errors in words", () => {
    expect(messageFor(new ApiError(409, "already_started"), "x")).toMatch(/already started/);
    expect(messageFor(new ApiError(409, "not_running"), "x")).toMatch(/not running/);
    expect(messageFor(new ApiError(404, "report_not_ready"), "x")).toMatch(/not ready/);
  });
});

describe("account and notification calls", () => {
  it("asks for a deletion code, then deletes with it", async () => {
    const { calls, fetchFn } = fakeFetch(() => reply(200, { ok: true }));
    const api = createHttpApi(fetchFn);
    await api.requestAccountDeletion();
    await api.deleteAccount("123456");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/account/delete-code",
      "DELETE /api/account",
    ]);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ code: "123456" });
    expect(calls[1]!.headers["x-csrf-token"]).toBe("csrf-1");
  });

  it("generates a test passcode", async () => {
    const issued = { code: "abcd-efgh-jkmn-pqrs", expiresAt: 5 };
    const { calls, fetchFn } = fakeFetch(() => reply(200, issued));
    expect(await createHttpApi(fetchFn).createTestPasscode("month")).toEqual(issued);
    expect(`${calls[0]!.method} ${calls[0]!.path}`).toBe("POST /api/account/test-passcode");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ lifetime: "month" });
  });

  it("confirms a notification link without a retry on 401", async () => {
    const { calls, fetchFn } = fakeFetch(() => reply(400, { error: "invalid_or_expired_link" }));
    await expect(createHttpApi(fetchFn).confirmNotify("tok")).rejects.toMatchObject({
      status: 400,
    });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ token: "tok" });
  });

  it("encodes ids in paths", async () => {
    const { calls, fetchFn } = fakeFetch(() => reply(200, {}));
    await createHttpApi(fetchFn).getRun("../x");
    expect(calls[0]!.path).toBe("/api/runs/..%2Fx");
  });
});
