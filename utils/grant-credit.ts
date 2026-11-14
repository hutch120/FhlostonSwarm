import { grantComp, type GrantArgs } from "../src/api/src/grant.js";
import { ssmSecrets } from "../src/api/src/secrets.js";
import { S3ObjectStore } from "../src/api/src/storage/store.js";
import { ACCOUNT_ID, DEFAULT_PROFILE, REGION, aws } from "./aws.js";
import { DATA_BUCKET } from "./test-cleanup.js";
import { secretParameterNames } from "./secrets.js";

export { grantComp, type GrantArgs, type GrantDeps } from "../src/api/src/grant.js";

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
