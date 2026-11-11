import type { AgentModule, RoleView, StepContext, StepResult } from "../types.js";
import {
  excerpt,
  gap,
  isAdmin,
  isPagePath,
  pathOnTarget,
  requestAs,
  roleName,
  type Probe,
} from "./support.js";

/** Identifier values tried per object type and pair of roles. */
const IDS_PER_PAIR = 2;
const MAX_TEMPLATES = 8;
const NUMERIC_SEGMENT = /\/(\d{1,12})(?=\/|$)/;

interface ObjectType {
  /** The path with the identifier replaced by `:id`. */
  template: string;
  /** The identifiers each role's pages link to. */
  owned: Map<string, Set<string>>;
}

const fill = (template: string, id: string): string => template.replace(":id", id);

/** Object types found in each role's pages: `/orders/:id` with who was shown which identifiers. */
export function objectTypes(ctx: StepContext): ObjectType[] {
  const types = new Map<string, ObjectType>();
  for (const role of ctx.roles()) {
    const pages = ctx.explorer?.pagesFor(role.slot) ?? [];
    const paths = pages.flatMap((p) => [
      pathOnTarget(ctx, p.url),
      ...p.links.map((l) => pathOnTarget(ctx, l.href)),
    ]);
    for (const full of paths) {
      if (!full || !isPagePath(full)) continue;
      const path = full.split("?")[0]!;
      const m = NUMERIC_SEGMENT.exec(path);
      if (!m) continue;
      const template = path.replace(NUMERIC_SEGMENT, "/:id");
      const type = types.get(template) ?? { template, owned: new Map() };
      const ids = type.owned.get(role.slot) ?? new Set<string>();
      ids.add(m[1]!);
      type.owned.set(role.slot, ids);
      types.set(template, type);
    }
  }
  return [...types.values()].slice(0, MAX_TEMPLATES);
}

async function ids(ctx: StepContext): Promise<StepResult> {
  if (ctx.roles().length === 0) {
    return gap(
      "No login held a session outside the browser, so object identifiers were not mapped by owner.",
    );
  }
  const types = objectTypes(ctx);
  if (types.length === 0) {
    return {
      outcome: "info",
      note: "No numeric object identifiers were found in the links of the pages explored.",
    };
  }
  const lines = types.map((t) => {
    const owners = [...t.owned.entries()].map(([slot, set]) => `${slot}: ${set.size}`).join(", ");
    return `${t.template} (${owners})`;
  });
  return {
    outcome: "info",
    note: `Found ${types.length} object ${types.length === 1 ? "type" : "types"} with numeric identifiers: ${lines.join("; ")}.`,
  };
}

interface Exposure {
  template: string;
  asRole: RoleView;
  ownerSlot: string;
  id: string;
  path: string;
  probe: Probe;
}

async function horizontal(ctx: StepContext): Promise<StepResult> {
  const roles = ctx.roles();
  const people = roles.filter((r) => !isAdmin(r));
  if (roles.length < 2) {
    return gap(
      "Testing one user's objects against another needs at least two logins, and fewer than two held a session outside the browser.",
    );
  }
  const types = objectTypes(ctx);
  if (types.length === 0) {
    return {
      outcome: "info",
      note: "No numeric object identifiers were found, so there was nothing to compare between users.",
    };
  }

  const exposures: Exposure[] = [];
  for (const type of types) {
    for (const asRole of people) {
      const mine = type.owned.get(asRole.slot) ?? new Set<string>();
      for (const [ownerSlot, theirs] of type.owned) {
        if (ownerSlot === asRole.slot) continue;
        const foreign = [...theirs].filter((id) => !mine.has(id)).slice(0, IDS_PER_PAIR);
        for (const id of foreign) {
          const path = fill(type.template, id);
          const got = await requestAs(ctx, asRole, path);
          // Public objects are not an access-control break: the visitor must be refused too.
          if (got?.access !== "allowed") continue;
          const visitor = await requestAs(ctx, null, path);
          if (visitor?.access === "allowed") continue;
          exposures.push({ template: type.template, asRole, ownerSlot, id, path, probe: got });
        }
      }
    }
  }
  if (exposures.length === 0) return { outcome: "clear" };

  const templates = [...new Set(exposures.map((e) => e.template))];
  return {
    outcome: "finding",
    finding: {
      title: `Users can read other users' records (IDOR): ${templates.slice(0, 3).join(", ")}`,
      severity: "high",
      component: templates.map((t) => `GET ${t}`).join(", "),
      description: `Changing the identifier in ${templates.join(", ")} returns records that belong to another user. The application checks that the caller is signed in, not that the record is theirs, so any user can read the records of every other user by walking the identifiers.`,
      impact: "Customers can read each other's data (orders, profiles and other personal records).",
      remediation:
        "Authorise every object request on the server: check that the signed-in user owns the record (or has a role that may read it) before returning it, and use unguessable identifiers as defence in depth.",
      mapping: "OWASP A01:2021 Broken Access Control (insecure direct object reference)",
      evidence: exposures
        .slice(0, 5)
        .map(
          (e) =>
            `As ${e.asRole.slot}: GET ${e.path} returned ${e.probe.status}, a record that ${e.ownerSlot}'s pages link to ("${excerpt(e.probe.body, 70)}").`,
        ),
      reproduction: [
        `Sign in as ${roleName(exposures[0]!.asRole)} and open one of your own records, such as ${fill(exposures[0]!.template, [...(types.find((t) => t.template === exposures[0]!.template)?.owned.get(exposures[0]!.asRole.slot) ?? ["1"])][0] ?? "1")}.`,
        `Change the identifier to ${exposures[0]!.id}, which belongs to ${exposures[0]!.ownerSlot}.`,
        "The other user's record is returned.",
      ],
      replay: async () => {
        let still = 0;
        const sample = exposures.slice(0, 4);
        for (const e of sample) {
          const again = await requestAs(ctx, e.asRole, e.path);
          const visitor = await requestAs(ctx, null, e.path);
          if (again?.access === "allowed" && visitor?.access !== "allowed") still += 1;
        }
        return {
          confirmed: still > 0,
          note: `Requested ${sample.length} other-user records again: ${still} were returned to the wrong user and refused to a visitor.`,
        };
      },
    },
  };
}

async function workflow(): Promise<StepResult> {
  return gap(
    "Skipping steps of a workflow means sending requests out of order, and those change state, which a read-only scan does not do, so it was not tested.",
  );
}

const EXPORT_PATH = /export|download|backup|dump|\.csv|\.xlsx|\.zip|report/i;

async function exportPaths(ctx: StepContext): Promise<StepResult> {
  const found = new Set<string>();
  for (const role of ctx.roles()) {
    for (const page of ctx.explorer?.pagesFor(role.slot) ?? []) {
      for (const link of page.links) {
        const path = pathOnTarget(ctx, link.href)?.split("?")[0];
        if (path && isPagePath(path) && EXPORT_PATH.test(path)) found.add(path);
      }
    }
  }
  if (found.size === 0) {
    return {
      outcome: "info",
      note: "No export or download links were found on the pages explored.",
    };
  }
  const open: { path: string; probe: Probe }[] = [];
  for (const path of [...found].slice(0, 8)) {
    const got = await requestAs(ctx, null, path);
    if (got?.access === "allowed") open.push({ path, probe: got });
  }
  if (open.length === 0) return { outcome: "clear" };
  return {
    outcome: "finding",
    finding: {
      title: `Export or download paths answer without signing in: ${open.map((o) => o.path).join(", ")}`,
      severity: "high",
      component: open.map((o) => `GET ${o.path}`).join(", "),
      description:
        "Links that signed-in users follow to export or download data answer a visitor with no login. Bulk data is reachable by anyone who knows the path.",
      remediation:
        "Require authentication and an ownership check on every export and download path.",
      mapping: "OWASP A01:2021 Broken Access Control",
      evidence: open.map((o) => `Signed out: GET ${o.path} returned ${o.probe.status}.`),
      replay: async () => {
        let still = 0;
        for (const o of open)
          if ((await requestAs(ctx, null, o.path))?.access === "allowed") still += 1;
        return {
          confirmed: still > 0,
          note: `Requested the paths again without a session: ${still} still answered.`,
        };
      },
    },
  };
}

export const idorAgent: AgentModule = {
  id: "idor",
  task: "Test whether one user can reach another user's objects",
  steps: { ids, horizontal, workflow, export: exportPaths },
  doneSummary: ({ checks, findings }) =>
    `Object access review finished: ${checks} checks, ${findings} ${findings === 1 ? "issue" : "issues"}.`,
};
