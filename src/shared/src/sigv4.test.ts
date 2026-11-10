import { describe, expect, it } from "vitest";
import { containerCredentials, signRequest, signedFetch } from "./sigv4.js";

const credentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

describe("SigV4", () => {
  it("matches the AWS test-suite vector (get-vanilla)", () => {
    const headers = signRequest({
      method: "GET",
      url: "https://example.amazonaws.com/",
      service: "service",
      region: "us-east-1",
      credentials,
      now: new Date("2015-08-30T12:36:00Z"),
    });
    expect(headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("matches the AWS test-suite vector for a POST with a body (post-x-www-form-urlencoded)", () => {
    const headers = signRequest({
      method: "POST",
      url: "https://example.amazonaws.com/",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "Param1=value1",
      service: "service",
      region: "us-east-1",
      credentials,
      now: new Date("2015-08-30T12:36:00Z"),
    });
    expect(headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a",
    );
  });

  it("signs the session token and the query string", () => {
    const headers = signRequest({
      method: "GET",
      url: "https://example.amazonaws.com/?b=2&a=1",
      service: "service",
      region: "us-east-1",
      credentials: { ...credentials, sessionToken: "TOKEN" },
      now: new Date("2015-08-30T12:36:00Z"),
    });
    expect(headers["x-amz-security-token"]).toBe("TOKEN");
    expect(headers["authorization"]).toContain(
      "SignedHeaders=host;x-amz-date;x-amz-security-token",
    );
  });

  it("signedFetch adds the signature and drops Host", async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const fetchFn = signedFetch({
      service: "execute-api",
      region: "ap-southeast-2",
      credentials: async () => credentials,
      fetchFn: async (url, init) => {
        seen = { url, headers: init?.headers as Record<string, string> };
        return new Response("{}");
      },
    });
    await fetchFn("https://abc.execute-api.ap-southeast-2.amazonaws.com/api/internal/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(seen?.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
    expect(seen?.headers["authorization"]).toContain("/ap-southeast-2/execute-api/aws4_request");
    expect(seen?.headers["host"]).toBeUndefined();
    expect(seen?.headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
  });
});

describe("container credentials", () => {
  it("reads the task role from the container endpoint and caches it until near expiry", async () => {
    let calls = 0;
    let now = Date.parse("2026-11-10T00:00:00Z");
    const provider = containerCredentials(
      { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/abc" },
      async (url) => {
        calls += 1;
        expect(url).toBe("http://169.254.170.2/v2/credentials/abc");
        return new Response(
          JSON.stringify({
            AccessKeyId: "A",
            SecretAccessKey: "S",
            Token: "T",
            Expiration: new Date(now + 3600_000).toISOString(),
          }),
        );
      },
      () => now,
    );
    expect(await provider()).toMatchObject({ accessKeyId: "A", sessionToken: "T" });
    await provider();
    expect(calls).toBe(1);
    now += 3300_000;
    await provider();
    expect(calls).toBe(2);
  });

  it("falls back to the environment outside a task", async () => {
    const provider = containerCredentials({ AWS_ACCESS_KEY_ID: "K", AWS_SECRET_ACCESS_KEY: "S" });
    expect(await provider()).toMatchObject({ accessKeyId: "K", secretAccessKey: "S" });
  });
});
