import { describe, expect, it } from "vitest";
import { emptyIntake, startedLogins, validateIntake, type IntakeValues } from "./intake.js";

const valid = (): IntakeValues => {
  const v = emptyIntake("owner@example.com");
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
  it("accepts a complete one-off submission and defaults to Sweep, one-off, account email", () => {
    const v = valid();
    expect(v.tier).toBe("sweep");
    expect(v.frequency).toBe("once");
    expect(v.notifyEmail).toBe("owner@example.com");
    expect(validateIntake(v)).toEqual({});
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
});

describe("tiers and logins", () => {
  it("Scout is unauthenticated: no logins are required or checked", () => {
    const v = { ...valid(), tier: "scout" as const };
    v.logins.user1 = { username: "", password: "", description: "", notes: "" };
    expect(validateIntake(v)).toEqual({});
    v.logins.admin.username = "half-filled";
    expect(validateIntake(v)).toEqual({});
  });

  it("deeper tiers need at least one complete login", () => {
    const v = valid();
    v.logins.user1 = { username: "", password: "", description: "", notes: "" };
    expect(validateIntake(v)["logins"]).toMatch(/at least one login/);
  });

  it("checks every started login is complete and ignores the others", () => {
    const v = valid();
    v.logins.user1.password = "";
    v.logins.admin.username = "half-filled";
    const errors = validateIntake({ ...v, tier: "siege" });
    expect(errors["login.user1.password"]).toBeTruthy();
    expect(errors["login.admin.password"]).toBeTruthy();
    expect(errors["login.user2.username"]).toBeUndefined();
  });

  it("limits the number of logins to what the tier uses", () => {
    const v = valid();
    v.logins.admin = { username: "a", password: "b", description: "Admin", notes: "" };
    expect(validateIntake({ ...v, tier: "sweep" })["logins"]).toMatch(/up to 1 login/);
    expect(validateIntake({ ...v, tier: "probe" })).toEqual({});
    v.logins.user2 = { username: "c", password: "d", description: "User", notes: "" };
    expect(validateIntake({ ...v, tier: "probe" })["logins"]).toMatch(/up to 2 logins/);
    expect(validateIntake({ ...v, tier: "siege" })).toEqual({});
    expect(startedLogins(v)).toEqual(["admin", "user1", "user2"]);
  });
});

describe("schedule and notification", () => {
  it("accepts every frequency", () => {
    for (const frequency of ["once", "daily", "weekly", "monthly", "yearly"] as const) {
      expect(validateIntake({ ...valid(), frequency })).toEqual({});
    }
    expect(
      validateIntake({ ...valid(), frequency: "hourly" as unknown as "daily" })["frequency"],
    ).toBeTruthy();
  });

  it("needs a valid notification email unless notifications are off", () => {
    expect(validateIntake({ ...valid(), notifyEmail: "" })["notifyEmail"]).toBeTruthy();
    expect(validateIntake({ ...valid(), notifyEmail: "not-an-email" })["notifyEmail"]).toBeTruthy();
    expect(validateIntake({ ...valid(), notifyEmail: "team@example.com" })).toEqual({});
    expect(validateIntake({ ...valid(), notifyEmail: "", notifyOn: "never" })).toEqual({});
  });

  it("rejects an unknown tier", () => {
    expect(
      validateIntake({ ...valid(), tier: "platinum" as unknown as "scout" })["tier"],
    ).toBeTruthy();
  });
});
