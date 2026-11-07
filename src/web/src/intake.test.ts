import { describe, expect, it } from "vitest";
import { emptyIntake, validateIntake, type IntakeValues } from "./intake.js";

const valid = (): IntakeValues => {
  const v = emptyIntake();
  v.appUrl = "https://staging.example.com";
  v.acknowledged = true;
  v.logins.user1 = {
    username: "swarm-test-user1",
    password: "not-a-real-password",
    description: "Standard customer",
    notes: "",
  };
  return v;
};

describe("validateIntake", () => {
  it("accepts a complete Lite submission", () => {
    expect(validateIntake(valid())).toEqual({});
  });

  it("requires an application URL that is http(s)", () => {
    expect(validateIntake({ ...valid(), appUrl: "" })["appUrl"]).toBeTruthy();
    expect(validateIntake({ ...valid(), appUrl: "staging.example.com" })["appUrl"]).toBeTruthy();
    expect(validateIntake({ ...valid(), appUrl: "ftp://example.com" })["appUrl"]).toBeTruthy();
  });

  it("treats the marketing URL as optional but validates it when given", () => {
    expect(validateIntake({ ...valid(), marketingUrl: "" })).toEqual({});
    expect(validateIntake({ ...valid(), marketingUrl: "nope" })["marketingUrl"]).toBeTruthy();
    expect(validateIntake({ ...valid(), marketingUrl: "https://www.example.com" })).toEqual({});
  });

  it("requires the authorisation acknowledgement", () => {
    expect(validateIntake({ ...valid(), acknowledged: false })["acknowledged"]).toMatch(
      /authorised/,
    );
  });

  it("requires the chosen Lite login to be complete and ignores the others", () => {
    const v = valid();
    v.logins.user1.password = "";
    v.logins.admin.username = "half-filled";
    const errors = validateIntake(v);
    expect(errors["login.user1.password"]).toBeTruthy();
    expect(errors["login.admin.password"]).toBeUndefined();
  });

  it("follows the selected Lite slot", () => {
    const v = valid();
    v.liteSlot = "other";
    expect(Object.keys(validateIntake(v)).sort()).toEqual([
      "login.other.description",
      "login.other.password",
      "login.other.username",
    ]);
  });

  it("in Full, only validates slots that have been started", () => {
    const v = valid();
    v.tier = "full";
    v.logins.admin.username = "admin-user";
    const errors = validateIntake(v);
    expect(errors["login.admin.password"]).toBeTruthy();
    expect(errors["login.user2.username"]).toBeUndefined();
  });
});
