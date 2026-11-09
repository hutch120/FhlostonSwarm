import { describe, expect, it } from "vitest";
import { getCredits } from "../src/api/src/credits.js";
import { emailHash, parseEmail } from "../src/api/src/identity.js";
import { MemoryStore } from "../src/api/src/storage/memory.js";
import { cdkArgs } from "./deploy.js";
import { grantComp, type GrantDeps } from "./grant-credit.js";
import { secretParameterNames } from "./secrets.js";
import { isCoveredByName, isTestRecord, isTestResourceName } from "./test-cleanup.js";

describe("grantComp", () => {
  const deps = (): GrantDeps & { store: MemoryStore } => ({
    store: new MemoryStore(),
    pepper: "test-pepper",
    by: "arn:aws:iam::885922397779:user/staff",
    now: () => Date.UTC(2026, 10, 10, 1, 2, 3),
  });
  const args = { email: "swarm-test-grantee@example.com", tier: "sweep", count: 2, reason: "beta" };
  const hash = emailHash("test-pepper", parseEmail(args.email)!);

  it("adds comp credits for the account and audit-logs the grant without the email", async () => {
    const d = deps();
    expect(await grantComp(d, args)).toEqual({ scout: 0, sweep: 2, probe: 0, siege: 0 });
    expect(await getCredits(d.store, hash)).toMatchObject({ sweep: 2 });

    const keysAfter = await d.store.list("admin/audit/");
    expect(keysAfter).toHaveLength(1);
    expect(keysAfter[0]).toMatch(/^admin\/audit\/2026\/11\/10\/\d+-[0-9a-f]{8}\.json$/);
    const raw = (await d.store.get(keysAfter[0]!))!.body;
    expect(JSON.parse(raw)).toEqual({
      test: true,
      at: "2026-11-10T01:02:03.000Z",
      action: "grant-credit",
      emailHash: hash,
      tier: "sweep",
      count: 2,
      source: "comp",
      reason: "beta",
      by: d.by,
    });
    expect(raw).not.toContain(args.email);
  });

  it("does not mark real accounts as test data", async () => {
    const d = deps();
    await grantComp(d, { ...args, email: "customer@example.com" });
    const [key] = await d.store.list("admin/audit/");
    expect(JSON.parse((await d.store.get(key!))!.body).test).toBeUndefined();
  });

  it("rejects bad input and writes nothing", async () => {
    const d = deps();
    for (const bad of [
      { ...args, email: "nope" },
      { ...args, tier: "platinum" },
      { ...args, count: 0 },
      { ...args, count: 1.5 },
      { ...args, count: 101 },
      { ...args, reason: "  " },
    ]) {
      await expect(grantComp(d, bad)).rejects.toThrow();
    }
    expect(await d.store.list("")).toEqual([]);
  });
});

describe("secretParameterNames", () => {
  it("reads the SecureString names from the infra config", () => {
    expect(secretParameterNames()).toEqual(["/swarm/auth/pepper", "/swarm/auth/jwt-key"]);
  });
});

describe("cdkArgs", () => {
  it("always uses the swarm profile and defaults to all stacks", () => {
    expect(cdkArgs("deploy", [])).toEqual(["deploy", "--all", "--profile", "swarm"]);
  });

  it("does not add --all when stacks are named", () => {
    expect(cdkArgs("diff", ["SwarmData"])).toEqual(["diff", "--profile", "swarm", "SwarmData"]);
  });

  it("keeps --all when only option values are passed", () => {
    expect(cdkArgs("deploy", ["--require-approval", "never"])).toEqual([
      "deploy",
      "--all",
      "--profile",
      "swarm",
      "--require-approval",
      "never",
    ]);
  });

  it("synth takes no --all", () => {
    expect(cdkArgs("synth", [])).toEqual(["synth", "--profile", "swarm"]);
  });
});

describe("test-cleanup matchers", () => {
  it("only treats test: true records as test data", () => {
    expect(isTestRecord({ test: true, testRunId: "x" })).toBe(true);
    expect(isTestRecord({ test: "true" })).toBe(false);
    expect(isTestRecord({ role: "customer" })).toBe(false);
    expect(isTestRecord(null)).toBe(false);
    expect(isTestRecord([true])).toBe(false);
  });

  it("only matches swarm-test-* names", () => {
    expect(isTestResourceName("swarm-test-e2e")).toBe(true);
    expect(isTestResourceName("swarm-data-885922397779")).toBe(false);
    expect(isTestResourceName("my-swarm-test-x")).toBe(false);
  });

  it("recognises tagged buckets and stacks already covered by name", () => {
    expect(isCoveredByName("arn:aws:s3:::swarm-test-a")).toBe(true);
    expect(isCoveredByName("arn:aws:s3:::swarm-data-885922397779")).toBe(false);
    expect(
      isCoveredByName("arn:aws:cloudformation:ap-southeast-2:885922397779:stack/swarm-test-a/abc"),
    ).toBe(true);
    expect(
      isCoveredByName("arn:aws:lambda:ap-southeast-2:885922397779:function:swarm-test-a"),
    ).toBe(false);
  });
});
