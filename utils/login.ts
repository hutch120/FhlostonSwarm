import { createInterface } from "node:readline/promises";
import { ACCOUNT_ID, DEFAULT_PROFILE, REGION, aws, getConfig, setConfig } from "./aws.js";

export interface LoginOptions {
  startUrl?: string;
  role?: string;
  profile?: string;
  browser?: boolean;
  remote?: boolean;
  sso?: boolean;
}

async function ask(question: string, fallback?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = fallback ? ` [${fallback}]` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || fallback || "";
  } finally {
    rl.close();
  }
}

/** Creates or updates an IAM Identity Center (SSO) profile in ~/.aws/config. */
async function ensureSsoProfile(profile: string, opts: LoginOptions): Promise<void> {
  const existingUrl = await getConfig(profile, "sso_start_url");
  const existingRole = await getConfig(profile, "sso_role_name");
  const existingAccount = await getConfig(profile, "sso_account_id");

  if (
    existingUrl &&
    existingRole &&
    existingAccount === ACCOUNT_ID &&
    !opts.startUrl &&
    !opts.role
  ) {
    return;
  }

  const startUrl =
    opts.startUrl ??
    existingUrl ??
    process.env.SWARM_SSO_START_URL ??
    (await ask("SSO start URL (https://d-xxxxxxxxxx.awsapps.com/start)"));
  if (!startUrl) throw new Error("An SSO start URL is required.");
  const role =
    opts.role ??
    existingRole ??
    process.env.SWARM_SSO_ROLE ??
    (await ask("SSO role / permission set name", "AdministratorAccess"));

  console.log(`Configuring AWS profile '${profile}' for account ${ACCOUNT_ID} (${REGION})...`);
  await setConfig(profile, "sso_start_url", startUrl);
  await setConfig(profile, "sso_region", REGION);
  await setConfig(profile, "sso_account_id", ACCOUNT_ID);
  await setConfig(profile, "sso_role_name", role);
}

export async function login(opts: LoginOptions): Promise<void> {
  const profile = opts.profile ?? process.env.SWARM_AWS_PROFILE ?? DEFAULT_PROFILE;

  const useSso = opts.sso || Boolean(opts.startUrl);

  await setConfig(profile, "region", REGION);
  await setConfig(profile, "output", "json");

  let args: string[];
  if (useSso) {
    await ensureSsoProfile(profile, opts);
    args = ["sso", "login", "--profile", profile];
    if (opts.browser === false) args.push("--no-browser");
  } else {
    // Console sign-in (root / IAM user / federated) via `aws login`; no IAM Identity Center needed.
    args = ["login", "--profile", profile];
    if (opts.remote) args.push("--remote");
  }

  const result = await aws(args, { inherit: true });
  if (result.code !== 0) throw new Error("AWS login failed.");

  const who = await aws(["sts", "get-caller-identity", "--profile", profile, "--output", "json"]);
  if (who.code !== 0)
    throw new Error(`Login succeeded but identity check failed:\n${who.stderr.trim()}`);

  const identity = JSON.parse(who.stdout) as { Account: string; Arn: string };
  if (identity.Account !== ACCOUNT_ID) {
    throw new Error(`Logged into unexpected account ${identity.Account} (expected ${ACCOUNT_ID}).`);
  }
  console.log(`\nLogged in as ${identity.Arn}`);
  console.log(`Use it with: aws <command> --profile ${profile}   (or set AWS_PROFILE=${profile})`);
}
