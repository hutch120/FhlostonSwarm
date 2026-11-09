import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import type { AuthenticatedSession } from "./sessions.js";

export interface Vars {
  auth: AuthenticatedSession;
}

export const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The viewer's IP from CloudFront, falling back to the connection (API Gateway, local dev). */
export function clientIp(c: Context): string {
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

export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "invalid_request" });
  }
  return schema.parse(raw);
}

/** Ends the request with `{ "error": code }` and the status. */
export const reject = (
  status: 400 | 401 | 402 | 403 | 404 | 409 | 429 | 503,
  code: string,
): never => {
  throw new HTTPException(status, { message: code });
};
