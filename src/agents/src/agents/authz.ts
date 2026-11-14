import type { AgentModule, RoleView, StepContext, StepResult } from "../types.js";
import {
  ADMIN_PATHS,
  PRIVILEGED,
  excerpt,
  gap,
  isAdmin,
  isPagePath,
  pathOnTarget,
  requestAs,
  roleName,
  sameShape,
  type Probe,
} from "./support.js";

/** Pages tested per run: enough to cover the navigation of a typical application, bounded for the request budget. */
const MAX_PATHS = 40;

interface Matrix {
  paths: string[];
  /** Path to (`visitor` or role slot) to what came back. */
  cells: Map<string, Map<string, Probe>>;
  /** Who saw a path linked on their pages: `public`, or a role slot. */
  seenBy: Map<string, Set<string>>;
}

const VISITOR = "visitor";
const WITH_ID = /\/\d+(?:\/|$)/;

/** Every path worth testing: what the roles' pages link to, what the plan hints at, robots.txt and the usual admin paths. */
async function candidatePaths(
  ctx: StepContext,
): Promise<{ paths: string[]; seenBy: Map<string, Set<string>> }> {
  const explorer = ctx.explorer;
  const seenBy = new Map<string, Set<string>>();
  const add = (path: string | null, who?: string) => {
    if (!path || !isPagePath(path)) return;
    const clean = path.split("?")[0]!;
    const set = seenBy.get(clean) ?? new Set<string>();
    if (who) set.add(who);
    seenBy.set(clean, set);
  };
  const scan = (slot: string) => {
    for (const page of explorer?.pagesFor(slot) ?? []) {
      add(pathOnTarget(ctx, page.url), slot);
      for (const link of page.links) add(pathOnTarget(ctx, link.href), slot);
    }
  };
  scan("public");
  for (const role of ctx.roles()) scan(role.slot);
  for (const route of ctx.plan?.hints.routes ?? []) add(route);

  // robots.txt names the places the owner wants kept out of search engines: often the sensitive ones.
  const robots = await requestAs(ctx, null, "/robots.txt");
  if (robots?.status === 200) {
    for (const m of robots.body.matchAll(/^\s*disallow\s*:\s*(\S+)/gim)) {
      const path = m[1]!.replace(/\*.*$/, "");
      if (path.length > 1) add(path);
    }
  }
  for (const path of ADMIN_PATHS) add(path);

  // Privileged-looking paths first, so the cap never drops them.
  const ordered = [...seenBy.keys()].sort(
    (a, b) => Number(PRIVILEGED.test(b)) - Number(PRIVILEGED.test(a)) || a.localeCompare(b),
  );
  return { paths: ordered.slice(0, MAX_PATHS), seenBy };
}

/** The access matrix: each path requested as the visitor and as every role, once per run. */
export async function accessMatrix(ctx: StepContext): Promise<Matrix> {
  const cached = ctx.shared.get("access-matrix") as Promise<Matrix> | undefined;
  if (cached) return cached;
  const built = (async (): Promise<Matrix> => {
    const { paths, seenBy } = await candidatePaths(ctx);
    const cells = new Map<string, Map<string, Probe>>();
    for (const path of paths) {
      const row = new Map<string, Probe>();
      const visitor = await requestAs(ctx, null, path);
      if (visitor) row.set(VISITOR, visitor);
      for (const role of ctx.roles()) {
        const got = await requestAs(ctx, role, path);
        if (got) row.set(role.slot, got);
      }
      cells.set(path, row);
    }
    return { paths, cells, seenBy };
  })();
  ctx.shared.set("access-matrix", built);
  return built;
}

const noRoles = (): StepResult =>
  gap("No login held a session outside the browser, so what each role can reach was not compared.");

async function matrix(ctx: StepContext): Promise<StepResult> {
  const roles = ctx.roles();
  if (roles.length === 0) return noRoles();
  const m = await accessMatrix(ctx);
  const differing = m.paths.filter((p) => {
    const row = m.cells.get(p)!;
    return new Set([...row.values()].map((c) => c.access)).size > 1;
  });
  const rows = differing.slice(0, 12).map((p) => {
    const row = m.cells.get(p)!;
    const cols = [VISITOR, ...roles.map((r) => r.slot)]
      .filter((k) => row.has(k))
      .map((k) => `${k} ${row.get(k)!.access}`);
    return `${p}: ${cols.join(", ")}`;
  });
  return {
    outcome: "info",
    note: `Requested ${m.paths.length} pages as the visitor and as ${roles.length} ${roles.length === 1 ? "login" : "logins"}; ${differing.length} answer differently by role.${rows.length > 0 ? ` ${rows.join(" | ")}.` : ""}`,
  };
}

/**
 * Pages an administrator reaches and the visitor does not, that look meant for administrators: named
 * like an administrative area, or linked only from the administrator's own pages. Object pages
 * (`/orders/101`) belong to the IDOR checks.
 */
function adminOnly(m: Matrix, admins: RoleView[]): string[] {
  const adminSlots = new Set(admins.map((a) => a.slot));
  return m.paths.filter((p) => {
    if (WITH_ID.test(p)) return false;
    const row = m.cells.get(p)!;
    const adminGets = admins.some((a) => row.get(a.slot)?.access === "allowed");
    const visitorGets = row.get(VISITOR)?.access === "allowed";
    const seen = [...(m.seenBy.get(p) ?? [])];
    const onlyAdminLinks = seen.length > 0 && seen.every((who) => adminSlots.has(who));
    return adminGets && !visitorGets && (PRIVILEGED.test(p) || onlyAdminLinks);
  });
}

async function vertical(ctx: StepContext): Promise<StepResult> {
  const roles = ctx.roles();
  const admins = roles.filter(isAdmin);
  const lower = roles.filter((r) => !isAdmin(r));
  if (roles.length === 0) return noRoles();
  if (admins.length === 0) {
    return gap(
      "No administrator login was supplied, so which pages are meant for administrators could not be established.",
    );
  }
  if (lower.length === 0)
    return gap("Only an administrator login was supplied, so there is no lower role to compare.");

  const m = await accessMatrix(ctx);
  const privileged = adminOnly(m, admins);
  if (privileged.length === 0) {
    return { outcome: "info", note: "No page was found that only an administrator reaches." };
  }

  const leaks: { role: RoleView; path: string; probe: Probe }[] = [];
  for (const path of privileged) {
    const row = m.cells.get(path)!;
    for (const role of lower) {
      const got = row.get(role.slot);
      const adminProbe = admins.map((a) => row.get(a.slot)).find((p) => p?.access === "allowed");
      // The lower role must get the administrator's page, not a generic page that happens to load.
      if (got?.access === "allowed" && adminProbe && got.status === adminProbe.status) {
        leaks.push({ role, path, probe: got });
      }
    }
  }
  if (leaks.length === 0) return { outcome: "clear" };

  const paths = [...new Set(leaks.map((l) => l.path))];
  const roleList = [...new Set(leaks.map((l) => roleName(l.role)))];
  return {
    outcome: "finding",
    finding: {
      title: `Pages meant for administrators are open to a lower role: ${paths.slice(0, 3).join(", ")}`,
      severity: "high",
      component: paths.map((p) => `GET ${p}`).join(", "),
      description: `The administrator reaches ${paths.length === 1 ? "this page" : "these pages"} and the visitor does not, so ${paths.length === 1 ? "it is" : "they are"} meant to be restricted. A lower-privileged login (${roleList.join("; ")}) gets ${paths.length === 1 ? "it" : "them"} as well. Access is decided by whether someone is signed in, not by what their role allows.`,
      impact:
        "Any signed-in user can use functions and read data that are meant for administrators.",
      remediation:
        "Check the caller's role on the server for every administrative page and endpoint, not only that they are signed in, and deny by default.",
      mapping: "OWASP A01:2021 Broken Access Control",
      evidence: leaks
        .slice(0, 5)
        .map(
          (l) =>
            `As ${l.role.slot}: GET ${l.path} returned ${l.probe.status} (${l.probe.contentType.split(";")[0] || "no content type"}): "${excerpt(l.probe.body, 80)}"`,
        ),
      reproduction: [
        `Sign in as the ${leaks[0]!.role.slot} login (not an administrator).`,
        `Request ${leaks[0]!.path} with that session.`,
        "The page is returned instead of an access-denied response.",
      ],
      replay: async () => {
        let still = 0;
        for (const l of leaks.slice(0, 5)) {
          const again = await requestAs(ctx, l.role, l.path);
          if (again?.access === "allowed" && again.status === l.probe.status) still += 1;
        }
        const checked = Math.min(5, leaks.length);
        return {
          confirmed: still > 0,
          note: `Requested ${checked} of the pages again as the lower role: ${still} still returned the administrator's page.`,
        };
      },
    },
  };
}

/** A path no application serves: a catch-all (single-page apps) answers it like any other path. */
const MISSING_PATH = "/swarm-check-no-such-page";

async function admin(ctx: StepContext): Promise<StepResult> {
  const m = await accessMatrix(ctx);
  // An answer identical to the one for a page that does not exist is the catch-all, not an admin page.
  const catchAll = await requestAs(ctx, null, MISSING_PATH);
  const isCatchAll = (p: Probe) => catchAll?.access === "allowed" && sameShape(p, catchAll);
  const open = m.paths.filter((p) => {
    const row = m.cells.get(p)!;
    const v = row.get(VISITOR);
    return (
      v?.access === "allowed" &&
      !isCatchAll(v) &&
      /^\/(?:admin|administrator|manage|console|api\/admin|api\/internal|actuator)\b/i.test(p) &&
      !/^\/$/.test(p)
    );
  });
  if (open.length === 0) return { outcome: "clear" };
  return {
    outcome: "finding",
    finding: {
      title: `Administrative paths answer without signing in: ${open.slice(0, 3).join(", ")}`,
      severity: "critical",
      component: open.map((p) => `GET ${p}`).join(", "),
      description: `The visitor, with no login, gets a normal answer from ${open.join(", ")}. Administrative functions are reachable by anyone.`,
      remediation:
        "Require authentication and an administrator role for every administrative path, and deny by default.",
      mapping: "OWASP A01:2021 Broken Access Control",
      evidence: open
        .slice(0, 4)
        .map((p) => `Signed out: GET ${p} returned ${m.cells.get(p)!.get(VISITOR)!.status}.`),
      replay: async () => {
        let still = 0;
        for (const p of open.slice(0, 4)) {
          const again = await requestAs(ctx, null, p);
          if (again?.access === "allowed" && !isCatchAll(again)) still += 1;
        }
        return {
          confirmed: still > 0,
          note: `Requested the paths again without a session: ${still} still answered normally.`,
        };
      },
    },
  };
}

async function methods(ctx: StepContext): Promise<StepResult> {
  const roles = ctx.roles();
  if (roles.length === 0) return noRoles();
  const m = await accessMatrix(ctx);
  const admins = roles.filter(isAdmin);
  const lower = roles.filter((r) => !isAdmin(r));
  // Pages a lower role is refused although an administrator is not: the ones worth trying another method on.
  const refused: { role: RoleView; path: string }[] = [];
  for (const path of m.paths) {
    const row = m.cells.get(path)!;
    if (!admins.some((a) => row.get(a.slot)?.access === "allowed")) continue;
    for (const role of lower) {
      if (row.get(role.slot)?.access === "denied") refused.push({ role, path });
    }
  }
  if (refused.length === 0) {
    return {
      outcome: "info",
      note: "No page was refused to a lower role, so there was nothing to try other request methods against.",
    };
  }
  const bypass: { role: RoleView; path: string; method: string; status: number }[] = [];
  for (const { role, path } of refused.slice(0, 6)) {
    for (const method of ["HEAD", "OPTIONS"] as const) {
      const got = await requestAs(ctx, role, path, method);
      // OPTIONS answers with the allowed methods whatever the role; only HEAD can leak a protected page.
      if (got && method === "HEAD" && got.status === 200) {
        bypass.push({ role, path, method, status: got.status });
      }
    }
  }
  if (bypass.length === 0) return { outcome: "clear" };
  return {
    outcome: "finding",
    finding: {
      title: "Access control can be bypassed with another request method",
      severity: "high",
      component: bypass.map((b) => `${b.method} ${b.path}`).join(", "),
      description: `A GET for ${[...new Set(bypass.map((b) => b.path))].join(", ")} is refused to a lower role, but the same request sent as ${[...new Set(bypass.map((b) => b.method))].join(" or ")} is answered. The access check only covers some methods.`,
      remediation:
        "Apply the authorisation check to every request method for a route (or deny the methods the route does not need).",
      mapping: "OWASP A01:2021 Broken Access Control",
      evidence: bypass
        .slice(0, 4)
        .map((b) => `As ${b.role.slot}: ${b.method} ${b.path} returned ${b.status}.`),
      replay: async () => {
        const first = bypass[0]!;
        const again = await requestAs(ctx, first.role, first.path, first.method as "HEAD");
        return {
          confirmed: again?.status === 200,
          note: `Sent ${first.method} ${first.path} again as ${first.role.slot}: status ${again?.status ?? "no answer"}.`,
        };
      },
    },
  };
}

export const authzAgent: AgentModule = {
  id: "authz",
  task: "Compare what each role can reach and look for broken access control",
  steps: { matrix, vertical, admin, methods },
  doneSummary: ({ checks, findings }) =>
    `Access review finished: ${checks} checks, ${findings} ${findings === 1 ? "issue" : "issues"}.`,
};
