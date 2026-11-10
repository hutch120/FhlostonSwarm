import { runtimeConfig } from "@swarm/shared/server";
import { SignJWT, jwtVerify } from "jose";
import { channelFor } from "./publisher.js";
import type { Secrets } from "./sessions.js";

const ISSUER = "swarm";
/** Distinct from the session audience: a session token cannot open a run stream, nor the reverse. */
const AUDIENCE = "swarm-run-stream";

export interface StreamClaims {
  runId: string;
  emailHash: string;
}

/** A short-lived token that lets one browser subscribe to one run's live channel. */
export async function mintStreamToken(
  secrets: Secrets,
  claims: StreamClaims,
  nowMs: number,
): Promise<{ token: string; expiresAt: string }> {
  const issuedAt = Math.floor(nowMs / 1000);
  const expires = issuedAt + Math.round(runtimeConfig.streamTokenMinutes * 60);
  const token = await new SignJWT({ run: claims.runId, owner: claims.emailHash })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expires)
    .sign(secrets.jwtKey);
  return { token, expiresAt: new Date(expires * 1000).toISOString() };
}

export async function verifyStreamToken(
  secrets: Secrets,
  token: string,
  nowMs: number = Date.now(),
): Promise<StreamClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secrets.jwtKey, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
      currentDate: new Date(nowMs),
    });
    const runId = payload["run"];
    const emailHash = payload["owner"];
    return typeof runId === "string" && typeof emailHash === "string" ? { runId, emailHash } : null;
  } catch {
    return null;
  }
}

/** What AppSync Events sends a Lambda authorizer. */
export interface AppSyncAuthEvent {
  authorizationToken?: string;
  requestContext?: {
    operation?: "EVENT_CONNECT" | "EVENT_SUBSCRIBE" | "EVENT_PUBLISH" | string;
    channel?: string;
  };
}

export interface AppSyncAuthResult {
  isAuthorized: boolean;
  handlerContext?: Record<string, string>;
  /** Seconds the decision may be cached. */
  ttlOverride?: number;
}

/**
 * Decides whether a browser may connect to, or subscribe to, the live channel. A token opens one
 * channel only, and no browser may publish: events come from the platform, over IAM.
 */
export async function authorizeAppSync(
  secrets: Secrets,
  event: AppSyncAuthEvent,
  nowMs: number = Date.now(),
): Promise<AppSyncAuthResult> {
  const deny: AppSyncAuthResult = { isAuthorized: false };
  const claims = event.authorizationToken
    ? await verifyStreamToken(secrets, event.authorizationToken, nowMs)
    : null;
  if (!claims) return deny;
  switch (event.requestContext?.operation) {
    case "EVENT_CONNECT":
      return { isAuthorized: true, ttlOverride: 60 };
    case "EVENT_SUBSCRIBE":
      return event.requestContext.channel === channelFor(claims.runId)
        ? { isAuthorized: true, ttlOverride: 60 }
        : deny;
    default:
      return deny;
  }
}
