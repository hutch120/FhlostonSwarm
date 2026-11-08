import { describe, expect, it } from "vitest";
import { cdkArgs } from "./deploy.js";
import { secretParameterNames } from "./secrets.js";
import { isCoveredByName, isTestRecord, isTestResourceName } from "./test-cleanup.js";

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
