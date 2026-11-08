import { describe, expect, it } from "vitest";
import {
  deriveRole,
  emailHash,
  hmacHex,
  isDisposable,
  parseEmail,
  testMarkerFor,
  type ParsedEmail,
} from "./identity.js";
import { testConfig } from "./testkit.js";

const parse = (raw: string): ParsedEmail => {
  const parsed = parseEmail(raw);
  if (!parsed) throw new Error(`not an email: ${raw}`);
  return parsed;
};

describe("parseEmail", () => {
  it("trims and lowercases, and keeps the address as typed for delivery", () => {
    expect(parse("  Buyer@Example.COM ")).toMatchObject({
      address: "buyer@example.com",
      normalised: "buyer@example.com",
    });
  });

  it("strips +tags", () => {
    expect(parse("buyer+promo@example.com").normalised).toBe("buyer@example.com");
    expect(parse("buyer+promo@example.com").address).toBe("buyer+promo@example.com");
  });

  it("collapses Gmail dots and the googlemail.com alias", () => {
    expect(parse("b.u.y.e.r+x@gmail.com").normalised).toBe("buyer@gmail.com");
    expect(parse("buyer@googlemail.com").normalised).toBe("buyer@gmail.com");
  });

  it("keeps dots for other domains", () => {
    expect(parse("first.last@example.com").normalised).toBe("first.last@example.com");
  });

  it.each([
    "",
    "no-at-sign",
    "a@b",
    "@example.com",
    "+tag@example.com",
    "two@@example.com",
    "spaces in@example.com",
    "unicode\u00e9@example.com",
    "a@exa mple.com",
    "a@example..com",
    `${"a".repeat(250)}@example.com`,
  ])("rejects %j", (raw) => {
    expect(parseEmail(raw)).toBeNull();
  });
});

describe("emailHash", () => {
  it("is deterministic and equal for aliases of the same mailbox", () => {
    const a = emailHash("pepper", parse("Buyer+one@Gmail.com"));
    const b = emailHash("pepper", parse("b.u.y.e.r@googlemail.com"));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("depends on the pepper and does not contain the address", () => {
    const email = parse("buyer@example.com");
    expect(emailHash("one", email)).not.toBe(emailHash("two", email));
    expect(emailHash("one", email)).not.toContain("buyer");
  });

  it("uses different namespaces for different kinds of value", () => {
    expect(hmacHex("p", "email:x@y.com")).not.toBe(hmacHex("p", "ip:x@y.com"));
  });
});

describe("isDisposable", () => {
  const config = testConfig();
  it("blocks listed domains and their subdomains only", () => {
    expect(isDisposable("mailinator.com", config)).toBe(true);
    expect(isDisposable("eu.mailinator.com", config)).toBe(true);
    expect(isDisposable("notmailinator.com", config)).toBe(false);
    expect(isDisposable("example.com", config)).toBe(false);
  });
});

describe("testMarker", () => {
  it("marks swarm-test- mailboxes and the SES simulator, and nothing else", () => {
    expect(testMarkerFor("swarm-test-e2e@fhlostonswarm.com")).toEqual({ test: true });
    expect(testMarkerFor("Bounce@simulator.amazonses.com")).toEqual({ test: true });
    expect(testMarkerFor("buyer@example.com")).toEqual({});
    expect(testMarkerFor("my-swarm-test-friend@example.com")).toEqual({});
    expect(testMarkerFor("not an email")).toEqual({});
  });
});

describe("deriveRole", () => {
  const config = testConfig();
  it("makes personal mailboxes on the exact staff domain staff", () => {
    expect(deriveRole(parse("sam@fhlostonswarm.com"), config)).toBe("staff");
    expect(deriveRole(parse("swarm-test-e2e@fhlostonswarm.com"), config)).toBe("staff");
    expect(deriveRole(parse("Sam+tag@FHLostonSwarm.com"), config)).toBe("staff");
  });

  it("denies shared and role addresses, even with a +tag", () => {
    for (const local of ["support", "login", "admin", "postmaster", "support+x"]) {
      expect(deriveRole(parse(`${local}@fhlostonswarm.com`), config), local).toBe("customer");
    }
  });

  it("denies other domains, subdomains and look-alikes", () => {
    for (const address of [
      "sam@gmail.com",
      "sam@mail.fhlostonswarm.com",
      "sam@fhlostonswarm.com.evil.com",
      "sam@fhlostonswarm.co",
      "sam@fh1ostonswarm.com",
      "sam@notfhlostonswarm.com",
    ]) {
      expect(deriveRole(parse(address), config), address).toBe("customer");
    }
  });
});
