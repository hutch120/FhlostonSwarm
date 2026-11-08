import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { Secrets } from "./sessions.js";

/** Reads the pepper and JWT key from SSM SecureStrings once per Lambda container. */
export function ssmSecrets(
  names: { pepper: string; jwtKey: string },
  client = new SSMClient({}),
): () => Promise<Secrets> {
  let cached: Promise<Secrets> | undefined;
  return () =>
    (cached ??= (async () => {
      const res = await client.send(
        new GetParametersCommand({ Names: [names.pepper, names.jwtKey], WithDecryption: true }),
      );
      const values = new Map((res.Parameters ?? []).map((p) => [p.Name, p.Value]));
      const pepper = values.get(names.pepper);
      const jwtKey = values.get(names.jwtKey);
      if (!pepper || !jwtKey) throw new Error("Auth secrets are missing from SSM");
      return { pepper, jwtKey: new TextEncoder().encode(jwtKey) };
    })().catch((err) => {
      cached = undefined;
      throw err;
    }));
}
