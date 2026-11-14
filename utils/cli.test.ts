import { describe, expect, it } from "vitest";
import { tiers } from "@swarm/shared";
import expected from "../src/synthetic-target/expected.json" with { type: "json" };
import { getCredits } from "../src/api/src/credits.js";
import { emailHash, parseEmail } from "../src/api/src/identity.js";
import { MemoryStore } from "../src/api/src/storage/memory.js";
import { cdkArgs } from "./deploy.js";
import { grantComp, type GrantDeps } from "./grant-credit.js";
import { evaluateGate } from "./learning.js";
import { secretParameterNames } from "./secrets.js";
import { parseNetwork, runTaskArgs } from "./synthetic-target.js";
import {
  isCoveredByName,
  isEcsTask,
  isPermanentTestInfrastructure,
  isTestRecord,
  isTestResourceName,
} from "./test-cleanup.js";

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

  it("treats the synthetic target's task definition and security group as permanent test infrastructure", () => {
    const groups = ["sg-0abc123"];
    expect(
      isPermanentTestInfrastructure(
        "arn:aws:ecs:ap-southeast-2:885922397779:task-definition/swarm-test-synthetic-target:3",
        groups,
      ),
    ).toBe(true);
    expect(
      isPermanentTestInfrastructure(
        "arn:aws:ec2:ap-southeast-2:885922397779:security-group/sg-0abc123",
        groups,
      ),
    ).toBe(true);
    // Anything else tagged as test data still shows up for manual review.
    expect(
      isPermanentTestInfrastructure(
        "arn:aws:ecs:ap-southeast-2:885922397779:task-definition/swarm-agent:3",
        groups,
      ),
    ).toBe(false);
    expect(
      isPermanentTestInfrastructure(
        "arn:aws:ec2:ap-southeast-2:885922397779:security-group/sg-0other",
        groups,
      ),
    ).toBe(false);
    expect(
      isPermanentTestInfrastructure(
        "arn:aws:ecs:ap-southeast-2:885922397779:task/swarm-runs/0123456789abcdef",
        groups,
      ),
    ).toBe(false);
  });

  it("does not list tagged ECS tasks for manual removal (running ones are stopped, stopped ones age out)", () => {
    expect(
      isEcsTask("arn:aws:ecs:ap-southeast-2:885922397779:task/swarm-runs/0123456789abcdef"),
    ).toBe(true);
    expect(isEcsTask("arn:aws:ecs:ap-southeast-2:885922397779:cluster/swarm-runs")).toBe(false);
  });
});

describe("synthetic target helpers", () => {
  it("reads the network from the runs stack outputs", () => {
    expect(
      parseNetwork([
        { OutputKey: "SyntheticTargetSubnets", OutputValue: "subnet-a,subnet-b" },
        { OutputKey: "SyntheticTargetSecurityGroupId", OutputValue: "sg-1" },
      ]),
    ).toEqual({ subnets: ["subnet-a", "subnet-b"], securityGroup: "sg-1" });
    expect(() => parseNetwork([])).toThrow(/Deploy it first/);
  });

  it("starts a public-IP Fargate task tagged as test data with the run id", () => {
    const args = runTaskArgs(
      { subnets: ["subnet-a"], securityGroup: "sg-1" },
      "20261110-120000-ab12",
    );
    expect(args).toEqual(
      expect.arrayContaining([
        "--task-definition",
        "swarm-test-synthetic-target",
        "--launch-type",
        "FARGATE",
        "key=swarm:test,value=true",
        "key=swarm:test-run,value=20261110-120000-ab12",
      ]),
    );
    expect(args.join(" ")).toContain("assignPublicIp=ENABLED");
    expect(args.join(" ")).toContain("securityGroups=[sg-1]");
  });
});

describe("the regression gate", () => {
  const finding = (agent: string, title: string) => ({ agent, title });
  const report = (findings: { agent: string; title: string }[]) => ({
    tier: "probe" as const,
    findings: findings as never,
  });
  const seeded = expected.findings
    .filter((f) => tiers.probe.agents.includes(f.agent))
    .map((f) => finding(f.agent, f.titleIncludes));
  const learnedTitle = expected.learned[0]!.titleIncludes;

  it("passes when every seeded issue the depth can reach was found and nothing else was", () => {
    expect(evaluateGate({ report: report(seeded), logins: 2, results: null })).toEqual({
      found: seeded.length,
      expected: seeded.length,
      stray: 0,
    });
  });

  it("counts a missing seeded issue and a stray finding, but not the learned issue the target seeds on purpose", () => {
    const missing = evaluateGate({ report: report(seeded.slice(1)), logins: 2, results: null });
    expect(missing.found).toBe(seeded.length - 1);
    const stray = evaluateGate({
      report: report([...seeded, finding("zap", "Something nobody seeded")]),
      logins: 2,
      results: null,
    });
    expect(stray.stray).toBe(1);
    const learned = evaluateGate({
      report: report([...seeded, finding("dyn-debug-vars", learnedTitle)]),
      logins: 2,
      results: null,
    });
    expect(learned.stray).toBe(0);
    // The same finding from an agent that is not a learned one is stray.
    expect(
      evaluateGate({
        report: report([...seeded, finding("zap", learnedTitle)]),
        logins: 2,
        results: null,
      }).stray,
    ).toBe(1);
  });

  it("counts what a candidate in shadow says it would raise: the seeded learned issue is fine, anything else is stray", () => {
    const results = (title: string) => ({
      version: 2,
      items: [],
      agents: [],
      wouldRaise: [{ agent: "dyn-x", check: "c", title, component: "GET /x" }],
    });
    expect(
      evaluateGate({ report: report(seeded), logins: 2, results: results(learnedTitle) }).stray,
    ).toBe(0);
    expect(
      evaluateGate({ report: report(seeded), logins: 2, results: results("A false alarm") }).stray,
    ).toBe(1);
  });

  it("does not expect what needs more logins than the run had", () => {
    const one = evaluateGate({ report: report([]), logins: 1, results: null });
    const two = evaluateGate({ report: report([]), logins: 2, results: null });
    expect(one.expected).toBeLessThan(two.expected);
  });
});
