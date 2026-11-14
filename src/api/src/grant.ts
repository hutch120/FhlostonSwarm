import { tierIdSchema, type TierId } from "@swarm/shared";
import { writeAudit } from "./audit.js";
import { grantCredits, type Credits } from "./credits.js";
import { emailHash, parseEmail, testMarker } from "./identity.js";
import type { ObjectStore } from "./storage/store.js";

export interface GrantArgs {
  email: string;
  tier: string;
  count: number;
  reason: string;
}

export interface GrantDeps {
  store: ObjectStore;
  pepper: string;
  /** Who is granting: the staff principal (an AWS principal from the CLI, a staff email from the dashboard). */
  by: string;
  now: () => number;
}

export const MAX_GRANT = 100;

/**
 * Adds `comp` credits to an account's ledger and writes an audit record under `admin/audit/`.
 * The record names the staff principal and the account hash (never the email), and outlives the
 * account. Returns the balance afterwards. Used by `swarm grant-credit` and the staff dashboard.
 */
export async function grantComp(deps: GrantDeps, args: GrantArgs): Promise<Credits> {
  const email = parseEmail(args.email);
  if (!email) throw new Error(`Not a valid email address: ${args.email}`);
  const tier = tierIdSchema.safeParse(args.tier);
  if (!tier.success)
    throw new Error(`Unknown depth '${args.tier}'. Use ${tierIdSchema.options.join(", ")}.`);
  if (!Number.isInteger(args.count) || args.count < 1 || args.count > MAX_GRANT)
    throw new Error(`Count must be a whole number from 1 to ${MAX_GRANT}.`);
  const reason = args.reason.trim();
  if (!reason) throw new Error("A reason is required.");

  const hash = emailHash(deps.pepper, email);
  const at = deps.now();
  const marker = testMarker(email);
  const credits = await grantCredits(
    deps.store,
    hash,
    { tier: tier.data, count: args.count, source: "comp", reason, by: deps.by },
    at,
    marker.test,
  );
  await writeAudit(deps.store, at, {
    ...marker,
    action: "grant-credit",
    emailHash: hash,
    tier: tier.data satisfies TierId,
    count: args.count,
    source: "comp",
    reason,
    by: deps.by,
  });
  return credits;
}
