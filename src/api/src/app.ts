import { TIER_IDS } from "@swarm/shared";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { z, ZodError } from "zod";
import type { AuthConfig } from "./config.js";
import { deriveRole, emailHash, ipHash, isDisposable, parseEmail } from "./identity.js";
import type { Mailer } from "./mailer.js";
import { issueChallenge, verifyChallenge } from "./otp.js";
import { hit } from "./ratelimit.js";
import {
  authenticate,
  createSession,
  csrfToken,
  revokeSession,
  rotateSession,
  sessionOfRefreshToken,
  signAccessToken,
  type AuthenticatedSession,
  type IssuedSession,
  type Secrets,
} from "./sessions.js";
import type { ObjectStore } from "./storage/store.js";
import { safeEqual } from "./identity.js";
import { isSuppressed, recordLogin } from "./users.js";

export interface AppDeps {
  store: ObjectStore;
  secrets: () => Promise<Secrets>;
  mailer: Mailer;
  config: AuthConfig;
  /** The public origin of the site, e.g. https://fhlostonswarm.com. Mutating calls must come from it. */
  siteOrigin: string;
  /** Use Secure cookies with __Host-/__Secure- prefixes. Only the local dev server turns this off. */
  cookieSecure: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Optional bot check (Turnstile). Absent = no check. */
  verifyHuman?: (token: string | undefined, ip: string) => Promise<boolean>;
}

interface Vars {
  auth: AuthenticatedSession;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const requestBody = z.object({
  email: z.string().max(254),
  turnstileToken: z.string().max(4096).optional(),
});

const verifyBody = z.union([
  z.object({ email: z.string().max(254), code: z.string().regex(/^\d{4,10}$/) }),
  z.object({ token: z.string().max(400) }),
]);

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function clientIp(c: Context): string {
  const viewer = c.req.header("cloudfront-viewer-address");
  if (viewer) {
    const colon = viewer.lastIndexOf(":");
    return (colon > 0 ? viewer.slice(0, colon) : viewer).replace(/^\[|\]$/g, "");
  }
  const env = c.env as
    | {
        event?: { requestContext?: { http?: { sourceIp?: string } } };
        incoming?: { socket?: { remoteAddress?: string } };
      }
    | undefined;
  return (
    env?.event?.requestContext?.http?.sourceIp ?? env?.incoming?.socket?.remoteAddress ?? "unknown"
  );
}

async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "invalid_request" });
  }
  return schema.parse(raw);
}

const json = (c: Context, status: 200 | 400 | 401 | 403 | 429, body: unknown) =>
  c.json(body, status);

/** The API, mounted under /api. Runs on Lambda (hono/aws-lambda) and the local dev server alike. */
export function createApp(deps: AppDeps) {
  const { store, config, mailer } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepMs;
  const allowedOrigin = new URL(deps.siteOrigin).origin;

  const accessCookie = deps.cookieSecure ? "__Host-swarm_at" : "swarm_at";
  const refreshCookie = deps.cookieSecure ? "__Secure-swarm_rt" : "swarm_rt";
  const refreshPath = "/api/auth";

  const app = new Hono<{ Variables: Vars }>().basePath("/api");

  app.use(
    secureHeaders({
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      strictTransportSecurity: "max-age=63072000; includeSubDomains",
      xFrameOptions: "DENY",
      referrerPolicy: "strict-origin-when-cross-origin",
    }),
  );

  app.use(async (c, next) => {
    const started = now();
    await next();
    c.header("Cache-Control", "no-store");
    // Method, path and timing only: never bodies, emails, codes or cookies.
    console.log(
      JSON.stringify({
        msg: "request",
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: now() - started,
      }),
    );
  });

  // CSRF layer 1: state-changing calls must come from our own origin and be JSON.
  app.use(async (c, next) => {
    if (MUTATING.has(c.req.method)) {
      if (c.req.header("origin") !== allowedOrigin)
        throw new HTTPException(403, { message: "bad_origin" });
      if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json"))
        throw new HTTPException(415, { message: "unsupported_media_type" });
    }
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof ZodError) return c.json({ error: "invalid_request" }, 400);
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(JSON.stringify({ msg: "unhandled_error", name: err.name }));
    return c.json({ error: "internal_error" }, 500);
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  const setSessionCookies = async (c: Context, issued: IssuedSession) => {
    const secrets = await deps.secrets();
    const access = await signAccessToken(secrets, issued.record, config, now());
    const base = { httpOnly: true, secure: deps.cookieSecure, sameSite: "Lax" as const };
    setCookie(c, accessCookie, access, {
      ...base,
      path: "/",
      maxAge: Math.round(config.session.accessTtlMinutes * 60),
    });
    setCookie(c, refreshCookie, issued.refreshToken, {
      ...base,
      sameSite: "Strict",
      path: refreshPath,
      maxAge: Math.round(config.session.refreshTtlDays * 86_400),
    });
    return {
      user: { email: issued.record.email, role: issued.record.role },
      csrfToken: csrfToken(secrets, issued.record.sessionId),
    };
  };

  const clearSessionCookies = (c: Context) => {
    const base = { httpOnly: true, secure: deps.cookieSecure, maxAge: 0 };
    setCookie(c, accessCookie, "", { ...base, sameSite: "Lax", path: "/" });
    setCookie(c, refreshCookie, "", { ...base, sameSite: "Strict", path: refreshPath });
  };

  const currentSession = async (c: Context): Promise<AuthenticatedSession | null> => {
    const token = getCookie(c, accessCookie);
    if (!token) return null;
    return authenticate(store, await deps.secrets(), token, now());
  };

  const requireAuth: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
    const auth = await currentSession(c);
    if (!auth) return json(c, 401, { error: "unauthenticated" });
    c.set("auth", auth);
    await next();
  };

  // CSRF layer 2: cookie-authenticated mutations also need the per-session token.
  const requireCsrf: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
    if (MUTATING.has(c.req.method)) {
      const expected = csrfToken(await deps.secrets(), c.get("auth").sessionId);
      const given = c.req.header("x-csrf-token");
      if (!given || !safeEqual(given, expected)) return json(c, 403, { error: "bad_csrf" });
    }
    await next();
  };

  const requireStaff: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
    if (c.get("auth").role !== "staff") return json(c, 403, { error: "forbidden" });
    await next();
  };

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.post("/auth/request", async (c) => {
    const started = now();
    const body = await readJson(c, requestBody);
    const parsed = parseEmail(body.email);
    if (!parsed) return json(c, 400, { error: "invalid_email" });

    const secrets = await deps.secrets();
    const ip = clientIp(c);
    if (
      !(await hit(
        store,
        `ip-${ipHash(secrets.pepper, ip)}-request`,
        config.rateLimits.requestPerIpPerHour,
        now(),
      ))
    )
      return json(c, 429, { error: "rate_limited" });
    if (deps.verifyHuman && !(await deps.verifyHuman(body.turnstileToken, ip)))
      return json(c, 400, { error: "verification_failed" });

    // Everything below answers the same way, whether or not a mail goes out.
    const hash = emailHash(secrets.pepper, parsed);
    const allowed =
      !isDisposable(parsed.domain, config) &&
      !(await isSuppressed(store, hash)) &&
      (await hit(store, `email-${hash}-request`, config.rateLimits.requestPerEmailPerHour, now()));
    if (allowed) {
      const { code, linkToken } = await issueChallenge(
        store,
        secrets.pepper,
        hash,
        parsed.address,
        config,
        now(),
      );
      try {
        await mailer.sendLoginCode({
          to: parsed.address,
          code,
          link: `${allowedOrigin}/auth/verify?token=${encodeURIComponent(linkToken)}`,
          expiresMinutes: config.otp.ttlMinutes,
        });
      } catch (err) {
        console.error(JSON.stringify({ msg: "mail_failed", name: (err as Error).name }));
      }
    }
    const wait = config.minRequestMs - (now() - started);
    if (wait > 0) await sleep(wait);
    return json(c, 200, { ok: true });
  });

  app.post("/auth/verify", async (c) => {
    const body = await readJson(c, verifyBody);
    const secrets = await deps.secrets();
    if (
      !(await hit(
        store,
        `ip-${ipHash(secrets.pepper, clientIp(c))}-verify`,
        config.rateLimits.verifyPerIpPerHour,
        now(),
      ))
    )
      return json(c, 429, { error: "rate_limited" });

    let hash: string | null = null;
    let proof: { code: string } | { linkSecret: string } | null = null;
    if ("token" in body) {
      const dot = body.token.indexOf(".");
      const candidate = body.token.slice(0, dot);
      if (dot > 0 && /^[0-9a-f]{64}$/.test(candidate)) {
        hash = candidate;
        proof = { linkSecret: body.token.slice(dot + 1) };
      }
    } else {
      const parsed = parseEmail(body.email);
      if (parsed && body.code.length === config.otp.codeLength) {
        hash = emailHash(secrets.pepper, parsed);
        proof = { code: body.code };
      }
    }
    const failure = () => json(c, 401, { error: "invalid_or_expired_code" });
    if (!hash || !proof) return failure();

    const outcome = await verifyChallenge(store, secrets.pepper, hash, proof, config, now());
    if (!outcome.ok) return failure();

    const parsed = parseEmail(outcome.email);
    if (!parsed) return failure();
    const role = deriveRole(parsed, config);
    await recordLogin(store, hash, outcome.email, role, now());
    const issued = await createSession(
      store,
      secrets,
      { emailHash: hash, email: outcome.email, role },
      config,
      now(),
    );
    return json(c, 200, await setSessionCookies(c, issued));
  });

  app.post("/auth/refresh", async (c) => {
    const token = getCookie(c, refreshCookie);
    const issued = token
      ? await rotateSession(store, await deps.secrets(), token, config, now())
      : null;
    if (!issued) {
      clearSessionCookies(c);
      return json(c, 401, { error: "unauthenticated" });
    }
    return json(c, 200, await setSessionCookies(c, issued));
  });

  app.get("/auth/session", async (c) => {
    const secrets = await deps.secrets();
    const auth = await currentSession(c);
    if (auth) {
      return json(c, 200, {
        authenticated: true,
        user: { email: auth.email, role: auth.role },
        csrfToken: csrfToken(secrets, auth.sessionId),
      });
    }
    // The short-lived access cookie has lapsed: renew it from the refresh cookie if that is valid.
    const token = getCookie(c, refreshCookie);
    const issued = token ? await rotateSession(store, secrets, token, config, now()) : null;
    if (!issued) {
      if (token) clearSessionCookies(c);
      return json(c, 200, { authenticated: false });
    }
    return json(c, 200, { authenticated: true, ...(await setSessionCookies(c, issued)) });
  });

  app.post("/auth/logout", async (c) => {
    const secrets = await deps.secrets();
    const auth = await currentSession(c);
    const refresh = getCookie(c, refreshCookie);
    const target = auth
      ? { emailHash: auth.emailHash, sessionId: auth.sessionId }
      : refresh
        ? sessionOfRefreshToken(refresh)
        : null;
    if (target) {
      const given = c.req.header("x-csrf-token");
      if (!given || !safeEqual(given, csrfToken(secrets, target.sessionId)))
        return json(c, 403, { error: "bad_csrf" });
      await revokeSession(store, target.emailHash, target.sessionId, now());
    }
    clearSessionCookies(c);
    return json(c, 200, { ok: true });
  });

  app.use("/me", requireAuth, requireCsrf);
  app.get("/me", async (c) => {
    const auth = c.get("auth");
    // There is no free tier: every run needs a paid or staff-granted credit. The credit ledger
    // (users/{hash}/entitlements.json) arrives with intake in Phase 4, so nobody holds credits yet.
    const credits = Object.fromEntries(TIER_IDS.map((tier) => [tier, 0]));
    return c.json({ email: auth.email, role: auth.role, entitlements: { credits } });
  });

  // Staff routes re-check the role from the server-side session on every call.
  app.use("/staff/*", requireAuth, requireCsrf, requireStaff);
  app.get("/staff/whoami", (c) => c.json({ email: c.get("auth").email, role: "staff" }));

  return app;
}

export type App = ReturnType<typeof createApp>;
