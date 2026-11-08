import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { aws, DEFAULT_PROFILE, REGION } from "./aws.js";

const CONFIG_URL = new URL("../src/infra/config/swarm.json", import.meta.url);

/** The SecureString parameters the API needs, from the infra config. */
export function secretParameterNames(
  config: { api: { pepperParameter: string; jwtKeyParameter: string } } = JSON.parse(
    readFileSync(CONFIG_URL, "utf8"),
  ),
): string[] {
  return [config.api.pepperParameter, config.api.jwtKeyParameter];
}

/**
 * Creates the auth pepper and JWT signing key as SSM SecureStrings (AWS-managed key, no extra
 * cost) if they do not exist. Never overwrites: replacing the pepper would orphan every hashed
 * identity, so rotation is a deliberate manual step. The values are never printed or stored in git.
 */
export async function initSecrets(): Promise<void> {
  for (const name of secretParameterNames()) {
    const common = ["--profile", DEFAULT_PROFILE, "--region", REGION];
    const existing = await aws(["ssm", "get-parameter", "--name", name, ...common]);
    if (existing.code === 0) {
      console.log(`exists   ${name}`);
      continue;
    }
    if (!existing.stderr.includes("ParameterNotFound")) {
      throw new Error(`Could not read ${name}: ${existing.stderr.trim()}`);
    }
    const created = await aws([
      "ssm",
      "put-parameter",
      "--name",
      name,
      "--type",
      "SecureString",
      "--value",
      randomBytes(48).toString("hex"),
      "--no-overwrite",
      "--tags",
      "Key=swarm:test,Value=false",
      ...common,
    ]);
    if (created.code !== 0) throw new Error(`Could not create ${name}: ${created.stderr.trim()}`);
    console.log(`created  ${name}`);
  }
}
