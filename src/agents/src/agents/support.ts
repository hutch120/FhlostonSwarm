import type { RoleKind } from "@swarm/shared/server";
import { RequestFailed, header, type HttpResult } from "../http.js";
import type { RoleView, StepContext, StepResult } from "../types.js";

export const gap = (reason: string): StepResult => ({ outcome: "gap", reason });

/** Reads what kind of role a login is from its slot and the owner's description of it. */
export function classifyRole(slot: string, description: string): RoleKind {
  const d = description.toLowerCase();
  if (/read[- ]?only|view[- ]?only|viewer|guest|auditor/.test(d)) return "readonly";
  if (slot === "admin" || /\badmin|owner|super ?user|root\b/.test(d)) return "admin";
  if (/manager|lead|support|elevated|power|moderator|staff/.test(d)) return "elevated";
  return slot === "other" ? "unknown" : "standard";
}

export const isAdmin = (role: RoleView): boolean => role.kind === "admin";

/** The name the report uses for a role. */
export const roleName = (role: { slot: string; description: string }): string =>
  `${role.slot} (${role.description})`;

/** Seconds-free, value-free shape of a response, for comparing what two roles got. */
const normalise = (body: string): string => body.replaceAll(/\s+/g, " ").trim().slice(0, 400);

export const hasPasswordField = (body: string): boolean => /type=["']?password/i.test(body);

export type Access = "allowed" | "denied" | "redirected" | "missing" | "error";

/** One request made as a role (or as the signed-out visitor when `role` is null). */
export interface Probe {
  status: number;
  access: Access;
  /** Where a redirect pointed. */
  location: string | null;
  contentType: string;
  /** The start of the body with whitespace collapsed (used to compare roles, never shown). */
  shape: string;
  body: string;
}

export function classify(res: HttpResult): Access {
  if (res.status === 401 || res.status === 403) return "denied";
  if (res.status === 404 || res.status === 410) return "missing";
  if (res.status >= 300 && res.status < 400) return "redirected";
  if (res.status >= 500) return "error";
  if (res.status === 200 && hasPasswordField(res.body)) return "redirected"; // served the sign-in page
  return res.status >= 200 && res.status < 300 ? "allowed" : "error";
}

/** GET (or HEAD or OPTIONS) as a role; null when the request itself could not be made. */
export async function requestAs(
  ctx: StepContext,
  role: Pick<RoleView, "cookie"> | null,
  path: string,
  method: "GET" | "HEAD" | "OPTIONS" = "GET",
): Promise<Probe | null> {
  try {
    const res = await ctx.http.request({
      url: new URL(path, ctx.appUrl).toString(),
      method,
      maxRedirects: 0,
      headers: role ? { cookie: role.cookie } : {},
    });
    return {
      status: res.status,
      access: classify(res),
      location: header(res, "location") ?? null,
      contentType: header(res, "content-type") ?? "",
      shape: normalise(res.body),
      body: res.body,
    };
  } catch (err) {
    if (err instanceof RequestFailed) return null;
    throw err;
  }
}

/** The same page for two requests: the second role did not get anything the first did not. */
export const sameShape = (a: Probe, b: Probe): boolean =>
  a.status === b.status && a.shape === b.shape;

const STATIC = /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|ico|woff2?|ttf|otf|webp|avif|mp4|pdf)$/i;

/** A path worth requesting as each role: a page or endpoint, not an asset. */
export const isPagePath = (path: string): boolean =>
  path.startsWith("/") &&
  !path.startsWith("//") &&
  !STATIC.test(path.split("?")[0]!) &&
  !/^\/(?:static|assets|_next|favicon)\b/.test(path);

/** The path of a URL on the target, or null when it is on another host. */
export function pathOnTarget(ctx: StepContext, url: string): string | null {
  try {
    const u = new URL(url, ctx.appUrl);
    return u.host === ctx.appUrl.host ? u.pathname + u.search : null;
  } catch {
    return null;
  }
}

/** The start of a reply as plain text on one line (markup removed), for an evidence excerpt. */
export const excerpt = (text: string, max = 160): string =>
  text
    .replaceAll(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, max);

/** A pattern that tells where an application keeps privileged pages. */
export const PRIVILEGED =
  /admin|manage|internal|settings|audit|report|config|console|billing|staff/i;

/** Paths where administrative functions usually live. */
export const ADMIN_PATHS = [
  "/admin",
  "/admin/",
  "/admin/users",
  "/administrator",
  "/manage",
  "/internal",
  "/console",
  "/dashboard/admin",
  "/api/admin",
  "/api/admin/users",
  "/api/internal",
  "/api/users",
  "/actuator/env",
];
