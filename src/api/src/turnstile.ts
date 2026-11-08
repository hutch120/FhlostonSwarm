import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

/** Cloudflare Turnstile server-side check. Only wired up when a secret parameter is configured. */
export function turnstileVerifier(secretParameter: string, ssm = new SSMClient({})) {
  let secret: Promise<string> | undefined;
  const loadSecret = () =>
    (secret ??= ssm
      .send(new GetParameterCommand({ Name: secretParameter, WithDecryption: true }))
      .then((r) => r.Parameter?.Value ?? "")
      .catch((err) => {
        secret = undefined;
        throw err;
      }));

  return async (token: string | undefined, ip: string): Promise<boolean> => {
    if (!token) return false;
    const body = new URLSearchParams({ secret: await loadSecret(), response: token, remoteip: ip });
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
    });
    return res.ok && ((await res.json()) as { success?: boolean }).success === true;
  };
}
