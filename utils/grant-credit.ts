import { randomBytes } from "node:crypto";
import { tierIdSchema, type TierId } from "@swarm/shared";
import { grantCredits, type Credits } from "../src/api/src/credits.js";
import { emailHash, parseEmail, testMarker } from "../src/api/src/identity.js";
import { ssmSecrets } from "../src/api/src/secrets.js";
import { putJson } from "../src/api/src/storage/json.js";
import { keys } from "../src/api/src/storage/keys.js";
import { S3ObjectStore, type ObjectStore } from "../src/api/src/storage/store.js";
import { ACCOUNT_ID, DEFAULT_PROFILE, REGION, aws } from "./aws.js";
import { DATA_BUCKET } from "./test-cleanup.js";
import { secretParameterNames } from "./secrets.js";

export interface GrantArgs {
  email: string;
  tier: string;
  count: number;
  reason: string;
}

export interface GrantDeps {
  store: ObjectStore;
  pepper: string;
  /** Who is granting: the AWS principal, recorded in the audit log. */
  by: string;
  now: () => number;
}

const MAX_GRANT = 100;

/**
 * Adds `comp` credits to an account's ledger and writes an audit record under `admin/audit/`.
 * The record names the staff principal and the account hash (never the email), and outlives the
 * account. Returns the balance afterwards.
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
  if (!reason) throw new Error("A reason is required (--reason).");

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
  await putJson(deps.store, keys.audit(new Date(at), `${at}-${randomBytes(4).toString("hex")}`), {
    ...marker,
    at: new Date(at).toISOString(),
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

/** The `swarm grant-credit` command: signs in with the swarm profile and grants against the live bucket. */
export async function grantCredit(args: GrantArgs): Promise<void> {
  // The AWS SDK reads these, so it uses the same profile and region as every other swarm command.
  process.env["AWS_PROFILE"] = DEFAULT_PROFILE;
  process.env["AWS_REGION"] = REGION;

  const identity = await aws([
    "sts",
    "get-caller-identity",
    "--profile",
    DEFAULT_PROFILE,
    "--output",
    "json",
  ]);
  if (identity.code !== 0) throw new Error("Could not read the caller identity. Run: swarm login");
  const { Account, Arn } = JSON.parse(identity.stdout) as { Account: string; Arn: string };
  if (Account !== ACCOUNT_ID)
    throw new Error(`Profile is account ${Account}, expected ${ACCOUNT_ID}.`);

  const names = secretParameterNames();
  const secrets = await ssmSecrets({ pepper: names[0]!, jwtKey: names[1]! })();
  const credits = await grantComp(
    { store: new S3ObjectStore(DATA_BUCKET), pepper: secrets.pepper, by: Arn, now: Date.now },
    args,
  );
  console.log(`Granted ${args.count} ${args.tier} credit${args.count === 1 ? "" : "s"} (comp).`);
  console.log(
    "Balance: " +
      Object.entries(credits)
        .map(([tier, n]) => `${n} ${tier}`)
        .join(", "),
  );
}
