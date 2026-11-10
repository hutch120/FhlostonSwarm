import { createHash, createHmac } from "node:crypto";

/**
 * A small AWS Signature Version 4 signer for JSON calls to API Gateway (IAM auth) and AppSync Events,
 * so the agent task and the API Lambda can sign requests without pulling in the AWS SDK.
 */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Epoch milliseconds; absent for long-lived keys. */
  expiresAt?: number;
}

export type CredentialsProvider = () => Promise<AwsCredentials>;

const sha256Hex = (data: string) => createHash("sha256").update(data, "utf8").digest("hex");
const hmac = (key: Buffer | string, data: string) =>
  createHmac("sha256", key).update(data).digest();

/** RFC 3986 percent-encoding, as SigV4 requires (`encodeURIComponent` leaves `!'()*` alone). */
const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export interface SignInput {
  method: string;
  url: string;
  /** Extra headers to send and sign (lowercase names are normalised). */
  headers?: Record<string, string>;
  body?: string;
  service: string;
  region: string;
  credentials: AwsCredentials;
  now?: Date;
}

/** Returns the full header set (including `authorization`) for the request. */
export function signRequest(input: SignInput): Record<string, string> {
  const url = new URL(input.url);
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const body = input.body ?? "";

  const headers: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()]),
    ),
    host: url.host,
    "x-amz-date": amzDate,
  };
  if (input.credentials.sessionToken)
    headers["x-amz-security-token"] = input.credentials.sessionToken;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  // Services other than S3 sign the path encoded twice.
  const canonicalPath = url.pathname
    .split("/")
    .map((segment) => encode(encode(decodeURIComponent(segment))))
    .join("/");
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath || "/",
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    sha256Hex(body),
  ].join("\n");

  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const key = hmac(
    hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, day), input.region), input.service),
    "aws4_request",
  );
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  headers["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Credentials from the environment (Lambda, local shells). */
export const environmentCredentials =
  (env: NodeJS.ProcessEnv = process.env): CredentialsProvider =>
  async () => {
    const accessKeyId = env["AWS_ACCESS_KEY_ID"];
    const secretAccessKey = env["AWS_SECRET_ACCESS_KEY"];
    if (!accessKeyId || !secretAccessKey) throw new Error("No AWS credentials in the environment");
    return { accessKeyId, secretAccessKey, sessionToken: env["AWS_SESSION_TOKEN"] };
  };

/** The ECS task role's credentials, from the container credentials endpoint. Cached until near expiry. */
export function containerCredentials(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: FetchLike = (input, init) => fetch(input, init),
  now: () => number = Date.now,
): CredentialsProvider {
  let cached: AwsCredentials | undefined;
  return async () => {
    if (cached && (!cached.expiresAt || cached.expiresAt - now() > 5 * 60_000)) return cached;
    const relative = env["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"];
    if (!relative) return environmentCredentials(env)();
    const res = await fetchFn(`http://169.254.170.2${relative}`);
    if (!res.ok) throw new Error(`Container credentials endpoint returned ${res.status}`);
    const data = (await res.json()) as {
      AccessKeyId: string;
      SecretAccessKey: string;
      Token?: string;
      Expiration?: string;
    };
    cached = {
      accessKeyId: data.AccessKeyId,
      secretAccessKey: data.SecretAccessKey,
      sessionToken: data.Token,
      expiresAt: data.Expiration ? Date.parse(data.Expiration) : undefined,
    };
    return cached;
  };
}

export interface SignedFetchOptions {
  service: string;
  region: string;
  credentials: CredentialsProvider;
  fetchFn?: FetchLike;
}

/** A `fetch` that signs every request with SigV4. */
export function signedFetch({
  service,
  region,
  credentials,
  fetchFn = (input, init) => fetch(input, init),
}: SignedFetchOptions): FetchLike {
  return async (url, init = {}) => {
    const body = typeof init.body === "string" ? init.body : undefined;
    const headers = signRequest({
      method: init.method ?? "GET",
      url,
      headers: init.headers as Record<string, string> | undefined,
      body,
      service,
      region,
      credentials: await credentials(),
    });
    // The HTTP client derives Host from the URL; it was only needed for the signature.
    delete headers["host"];
    return fetchFn(url, { ...init, headers });
  };
}
