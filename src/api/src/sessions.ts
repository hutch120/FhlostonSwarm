import { createHmac, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import type { AuthConfig } from "./config.js";
import {
  deriveRole,
  hmacHex,
  parseEmail,
  safeEqual,
  testMarkerFor,
  type Role,
} from "./identity.js";
import { ContentionError, getJson, putJson, updateJson } from "./storage/json.js";
import { keys } from "./storage/keys.js";
import type { ObjectStore } from "./storage/store.js";

const ISSUER = "swarm";
const AUDIENCE = "swarm-web";

const sessionSchema = z.object({
  sessionId: z.string(),
  emailHash: z.string(),
  email: z.string(),
  test: z.boolean().optional(),
  role: z.enum(["customer", "staff"]),
  refreshHash: z.string(),
  /** The refresh token this one replaced; presenting it again means it was stolen or replayed. */
  previousRefreshHash: z.string().nullable(),
  createdAt: z.number(),
  rotatedAt: z.number(),
  expiresAt: z.number(),
  revokedAt: z.number().nullable(),
});

export type SessionRecord = z.infer<typeof sessionSchema>;

export interface Secrets {
  /** Keys emailHash, ipHash and OTP digests. */
  pepper: string;
  /** Signs access tokens and CSRF tokens. */
  jwtKey: Uint8Array;
}

const refreshDigest = (pepper: string, secret: string) => hmacHex(pepper, `refresh:${secret}`);

const formatRefreshToken = (emailHash: string, sessionId: string, secret: string) =>
  `${emailHash}.${sessionId}.${secret}`;

function parseRefreshToken(token: string) {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0 || p.length > 200)) return null;
  const [emailHash, sessionId, secret] = parts as [string, string, string];
  if (!/^[0-9a-f]{64}$/.test(emailHash) || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  return { emailHash, sessionId, secret };
}

export interface IssuedSession {
  record: SessionRecord;
  refreshToken: string;
}

export async function createSession(
  store: ObjectStore,
  secrets: Secrets,
  user: { emailHash: string; email: string; role: Role },
  config: AuthConfig,
  now: number,
): Promise<IssuedSession> {
  const sessionId = randomBytes(18).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const record: SessionRecord = {
    sessionId,
    emailHash: user.emailHash,
    email: user.email,
    ...testMarkerFor(user.email),
    role: user.role,
    refreshHash: refreshDigest(secrets.pepper, secret),
    previousRefreshHash: null,
    createdAt: now,
    rotatedAt: now,
    expiresAt: now + config.session.refreshTtlDays * 86_400_000,
    revokedAt: null,
  };
  await putJson(store, keys.session(user.emailHash, sessionId), record);
  return { record, refreshToken: formatRefreshToken(user.emailHash, sessionId, secret) };
}

/**
 * Exchanges a refresh token for a new one. The old token stops working immediately; presenting an
 * already-rotated token revokes the whole session. The role is re-derived from the email.
 */
export async function rotateSession(
  store: ObjectStore,
  secrets: Secrets,
  refreshToken: string,
  config: AuthConfig,
  now: number,
): Promise<IssuedSession | null> {
  const parsed = parseRefreshToken(refreshToken);
  if (!parsed) return null;
  const presented = refreshDigest(secrets.pepper, parsed.secret);
  const newSecret = randomBytes(32).toString("base64url");
  let issued: SessionRecord | null = null;
  try {
    await updateJson(
      store,
      keys.session(parsed.emailHash, parsed.sessionId),
      sessionSchema,
      (current) => {
        issued = null;
        if (!current || current.revokedAt !== null || now > current.expiresAt) return undefined;
        if (current.previousRefreshHash && safeEqual(presented, current.previousRefreshHash)) {
          return { ...current, revokedAt: now };
        }
        if (!safeEqual(presented, current.refreshHash)) return undefined;
        const email = parseEmail(current.email);
        issued = {
          ...current,
          role: email ? deriveRole(email, config) : "customer",
          refreshHash: refreshDigest(secrets.pepper, newSecret),
          previousRefreshHash: current.refreshHash,
          rotatedAt: now,
          expiresAt: now + config.session.refreshTtlDays * 86_400_000,
        };
        return issued;
      },
    );
  } catch (err) {
    if (err instanceof ContentionError) return null;
    throw err;
  }
  const record = issued as SessionRecord | null;
  if (!record) return null;
  return {
    record,
    refreshToken: formatRefreshToken(parsed.emailHash, parsed.sessionId, newSecret),
  };
}

/** Server-side logout: the refresh token and the access token both stop working at once. */
export async function revokeSession(
  store: ObjectStore,
  emailHash: string,
  sessionId: string,
  now: number,
): Promise<void> {
  await updateJson(store, keys.session(emailHash, sessionId), sessionSchema, (current) =>
    current && current.revokedAt === null ? { ...current, revokedAt: now } : undefined,
  );
}

/** Which session a refresh token belongs to, without exchanging it. */
export function sessionOfRefreshToken(token: string) {
  const parsed = parseRefreshToken(token);
  return parsed ? { emailHash: parsed.emailHash, sessionId: parsed.sessionId } : null;
}

export async function signAccessToken(
  secrets: Secrets,
  record: SessionRecord,
  config: AuthConfig,
  now: number,
): Promise<string> {
  return new SignJWT({ sid: record.sessionId, role: record.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(record.emailHash)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(Math.floor(now / 1000) + Math.round(config.session.accessTtlMinutes * 60))
    .sign(secrets.jwtKey);
}

export interface AuthenticatedSession {
  emailHash: string;
  sessionId: string;
  email: string;
  role: Role;
}

/**
 * Validates the access token and then the server-side session, so logout takes effect at once.
 * The role comes from the session record, never from the token alone.
 */
export async function authenticate(
  store: ObjectStore,
  secrets: Secrets,
  accessToken: string,
  now: number,
): Promise<AuthenticatedSession | null> {
  let sub: string | undefined;
  let sid: unknown;
  try {
    const { payload } = await jwtVerify(accessToken, secrets.jwtKey, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
      currentDate: new Date(now),
    });
    sub = payload.sub;
    sid = payload["sid"];
  } catch {
    return null;
  }
  if (!sub || typeof sid !== "string") return null;
  const session = await getJson(store, keys.session(sub, sid), sessionSchema);
  if (!session || session.value.revokedAt !== null || now > session.value.expiresAt) return null;
  return {
    emailHash: sub,
    sessionId: sid,
    email: session.value.email,
    role: session.value.role,
  };
}

/** Double-submit style token bound to the session; the page gets it from /auth/session. */
export function csrfToken(secrets: Secrets, sessionId: string): string {
  return createHmac("sha256", secrets.jwtKey).update(`csrf:${sessionId}`).digest("base64url");
}
