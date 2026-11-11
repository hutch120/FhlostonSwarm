import { describe, expect, it } from "vitest";
import { REDACTED, redactDeep, redactText } from "./redact.js";

const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";

describe("redactText", () => {
  it.each([
    ["a known password", "login with hunter2-secret now", { secrets: ["hunter2-secret"] }],
    ["a bearer token", "Authorization: Bearer abcdef1234567890", {}],
    ["a JWT", `token is ${JWT}`, {}],
    ["an AWS access key", "key AKIAIOSFODNN7EXAMPLE leaked", {}],
    ["a cookie header", "Cookie: sessionid=abc123def456; theme=dark", {}],
    ["a set-cookie header", "Set-Cookie: connect.sid=s%3Aabc.def; Path=/", {}],
    ["a session pair", "the cookie session=0123456789abcdef is set", {}],
    ["a JSON password", '{"username":"a","password":"pa55w0rd!"}', {}],
    ["a form password", "username=a&password=pa55w0rd", {}],
    ["a private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----", {}],
  ])("removes %s", (_name, text, options) => {
    const out = redactText(text, options);
    expect(out).toContain(REDACTED);
    for (const planted of [
      "hunter2-secret",
      "abcdef1234567890",
      JWT,
      "AKIAIOSFODNN7EXAMPLE",
      "abc123def456",
      "s%3Aabc.def",
      "0123456789abcdef",
      "pa55w0rd",
      "MIIabc",
    ]) {
      expect(out).not.toContain(planted);
    }
  });

  it("removes a known secret in its URL-encoded form too", () => {
    expect(redactText("q=p%40ss%20word1", { secrets: ["p@ss word1"] })).not.toContain("p%40ss");
  });

  it("leaves ordinary prose and short values alone", () => {
    const text = "Security headers are missing on GET /home (status 200).";
    expect(redactText(text)).toBe(text);
  });

  it("handles a cookie header without eating prose that mentions a cookie", () => {
    const prose = "Measured 2 fresh identifiers from the same cookie: 2 had under 64 bits.";
    expect(redactText(prose)).toBe(prose);
  });

  it("masks email addresses only when asked", () => {
    expect(redactText("owner admin@example.com")).toContain("admin@example.com");
    expect(redactText("owner admin@example.com", { emails: true })).toBe("owner a***@example.com");
  });
});

describe("redactDeep", () => {
  it("scrubs every string in a nested value and keeps the shape", () => {
    const value = { a: ["x password=hunter22"], b: { c: "Bearer zzzzzzzzzz", n: 3 }, d: null };
    const out = redactDeep(value);
    expect(JSON.stringify(out)).not.toContain("hunter22");
    expect(JSON.stringify(out)).not.toContain("zzzzzzzzzz");
    expect(out.b.n).toBe(3);
    expect(out.d).toBeNull();
  });
});
