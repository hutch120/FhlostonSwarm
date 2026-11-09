import { describe, expect, it } from "vitest";
import { intakeConfig, intakeConfigSchema } from "./config.js";
import { parseTargetUrl } from "./hosts.js";

const parse = (url: string) => parseTargetUrl(url, intakeConfig);

describe("intake config", () => {
  it("loads, and an invalid one fails to load", () => {
    expect(intakeConfigSchema.safeParse(intakeConfig).success).toBe(true);
    const bad = (over: object) =>
      intakeConfigSchema.safeParse({ ...intakeConfig, ...over }).success;
    expect(bad({ quotas: { maxTargets: 0, maxScans: 5 } })).toBe(false);
    expect(bad({ notifyConfirm: { ...intakeConfig.notifyConfirm, ttlHours: -1 } })).toBe(false);
    expect(bad({ blockedHosts: { ...intakeConfig.blockedHosts, domains: ["Not A Host"] } })).toBe(
      false,
    );
    expect(bad({ blockedHosts: undefined })).toBe(false);
  });

  it("blocks our own domain", () => {
    expect(intakeConfig.blockedHosts.domains).toContain("fhlostonswarm.com");
  });
});

describe("parseTargetUrl", () => {
  it("accepts ordinary http(s) hosts and returns the hostname and registrable domain", () => {
    expect(parse("https://Staging.Example.com/login?x=1")).toEqual({
      ok: true,
      hostname: "staging.example.com",
      registrableDomain: "example.com",
    });
    expect(parse("http://app.example.co.uk:8443")).toMatchObject({
      ok: true,
      hostname: "app.example.co.uk",
      registrableDomain: "example.co.uk",
    });
    expect(parse("https://203.0.113.7.nip.example.com")).toMatchObject({ ok: true });
  });

  it("accepts a public IP address but no private or reserved one", () => {
    expect(parse("http://93.184.216.34/")).toMatchObject({ ok: true, registrableDomain: null });
    for (const url of [
      "http://127.0.0.1",
      "http://10.1.2.3",
      "http://172.16.0.1",
      "http://172.31.255.255",
      "http://192.168.1.1",
      "http://169.254.169.254/latest/meta-data",
      "http://100.64.0.1",
      "http://0.0.0.0",
      "http://224.0.0.1",
      "http://255.255.255.255",
      "http://198.18.0.1",
      "http://203.0.113.9",
    ]) {
      expect(parse(url), url).toEqual({ ok: false, problem: "private_address" });
    }
  });

  it("normalises tricky IPv4 forms before checking them", () => {
    expect(parse("http://2130706433/")).toEqual({ ok: false, problem: "private_address" });
    expect(parse("http://0x7f.1/")).toEqual({ ok: false, problem: "private_address" });
    expect(parse("http://017700000001/")).toEqual({ ok: false, problem: "private_address" });
    expect(parse("http://127.1/")).toEqual({ ok: false, problem: "private_address" });
  });

  it("blocks private, link-local and mapped IPv6 literals", () => {
    for (const url of [
      "http://[::1]/",
      "http://[::]/",
      "http://[fe80::1]/",
      "http://[fd00::1]/",
      "http://[fc00::1]/",
      "http://[ff02::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:a9fe:a9fe]/",
      "http://[64:ff9b::7f00:1]/",
      "http://[2002:7f00:1::]/",
      "http://[2001:db8::1]/",
    ]) {
      expect(parse(url), url).toEqual({ ok: false, problem: "private_address" });
    }
    expect(parse("http://[2606:4700:4700::1111]/")).toMatchObject({ ok: true });
  });

  it("blocks names that only resolve inside a network", () => {
    for (const url of [
      "http://localhost",
      "http://app.localhost",
      "http://intranet",
      "http://printer.local",
      "http://metadata.google.internal",
      "http://server.home.arpa",
      "http://db.corp.lan",
    ]) {
      expect(parse(url), url).toEqual({ ok: false, problem: "unroutable_host" });
    }
  });

  it("blocks our own domains, well-known services and public-sector suffixes", () => {
    for (const url of [
      "https://fhlostonswarm.com",
      "https://api.fhlostonswarm.com",
      "https://mail.google.com",
      "https://www.stripe.com",
      "https://agency.gov.au",
      "https://example.gov",
      "https://base.mil",
    ]) {
      expect(parse(url), url).toEqual({ ok: false, problem: "blocked_host" });
    }
    expect(parse("https://notfhlostonswarm.com")).toMatchObject({ ok: true });
    expect(parse("https://fhlostonswarm.com.evil.example.org")).toMatchObject({ ok: true });
  });

  it("rejects non-http schemes, embedded credentials and garbage", () => {
    for (const url of ["ftp://example.com", "javascript:alert(1)", "file:///etc/passwd", "", "x"]) {
      expect(parse(url), url).toEqual({ ok: false, problem: "invalid_url" });
    }
    expect(parse("https://user:pw@example.com")).toEqual({
      ok: false,
      problem: "credentials_in_url",
    });
    expect(parse("https://com")).toEqual({ ok: false, problem: "unroutable_host" });
  });
});
