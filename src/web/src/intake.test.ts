import { describe, expect, it } from "vitest";
import {
  defaultScanName,
  editLogin,
  emptyIntake,
  fitLogins,
  startedLogins,
  toScanInput,
  toTargetInput,
  usedLogins,
  validateIntake,
  valuesFromScan,
  withTarget,
  type IntakeValues,
  type LoginValues,
} from "./intake.js";
import { MOCK_SCANS, MOCK_TARGETS } from "./api/mock.js";

const login = (over: Partial<LoginValues> = {}): LoginValues => ({
  username: "swarm-test-user1",
  password: "not-a-real-password",
  description: "Standard customer",
  notes: "",
  use: true,
  saved: false,
  ...over,
});

const blank = (): LoginValues => ({
  username: "",
  password: "",
  description: "",
  notes: "",
  use: false,
  saved: false,
});

const valid = (): IntakeValues => {
  const v = emptyIntake("owner@example.com");
  v.appUrl = "https://staging.example.com";
  v.acknowledged = true;
  v.logins.user1 = login();
  return v;
};

describe("validateIntake", () => {
  it("accepts a complete one-off submission and defaults to Sweep, one-off, account email", () => {
    const v = valid();
    expect(v.tier).toBe("sweep");
    expect(v.frequency).toBe("once");
    expect(v.notifyEmail).toBe("owner@example.com");
    expect(v.targetId).toBeNull();
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

  it("keeps the scan name short", () => {
    expect(validateIntake({ ...valid(), name: "x".repeat(81) })["name"]).toBeTruthy();
    expect(validateIntake({ ...valid(), name: "" })).toEqual({});
  });
});

describe("tiers and logins", () => {
  it("Scout is unauthenticated: no logins are required or checked", () => {
    const v = { ...valid(), tier: "scout" as const };
    v.logins.user1 = blank();
    expect(validateIntake(v)).toEqual({});
    v.logins.admin.username = "half-filled";
    expect(validateIntake(v)).toEqual({});
  });

  it("deeper tiers need at least one login that the scan uses", () => {
    const v = valid();
    v.logins.user1 = blank();
    expect(validateIntake(v)["logins"]).toMatch(/at least one login/);
    v.logins.user1 = login({ use: false });
    expect(validateIntake(v)["logins"]).toMatch(/at least one login/);
  });

  it("checks every started login is complete and ignores the others", () => {
    const v = valid();
    v.logins.user1.password = "";
    v.logins.admin = { ...blank(), username: "half-filled" };
    const errors = validateIntake({ ...v, tier: "siege" });
    expect(errors["login.user1.password"]).toBeTruthy();
    expect(errors["login.admin.password"]).toBeTruthy();
    expect(errors["login.user2.username"]).toBeUndefined();
  });

  it("a saved password counts as entered, so it can be left blank", () => {
    const v = valid();
    v.logins.user1 = login({ password: "", saved: true });
    expect(validateIntake(v)).toEqual({});
  });

  it("limits the logins a scan uses to what the tier uses, but keeps spare ones on the target", () => {
    const v = valid();
    v.logins.admin = login({ username: "a", description: "Admin" });
    expect(validateIntake({ ...v, tier: "sweep" })["logins"]).toMatch(/up to 1 login/);
    // A login that is saved on the target but not used by this scan does not count.
    v.logins.admin.use = false;
    expect(validateIntake({ ...v, tier: "sweep" })).toEqual({});
    v.logins.admin.use = true;
    expect(validateIntake({ ...v, tier: "probe" })).toEqual({});
    v.logins.user2 = login({ username: "c", description: "User" });
    expect(validateIntake({ ...v, tier: "probe" })["logins"]).toMatch(/up to 2 logins/);
    expect(validateIntake({ ...v, tier: "siege" })).toEqual({});
    expect(startedLogins(v)).toEqual(["admin", "user1", "user2"]);
    expect(usedLogins(v)).toEqual(["admin", "user1", "user2"]);
  });
});

describe("choosing logins", () => {
  it("selects a login for the scan as soon as it is started, while the depth has room", () => {
    let v = emptyIntake("owner@example.com");
    v = editLogin(v, "user1", { username: "a" });
    expect(v.logins.user1.use).toBe(true);
    v = editLogin(v, "admin", { username: "b" });
    expect(v.logins.admin.use).toBe(false);
    v = editLogin(v, "admin", { use: true });
    expect(v.logins.admin.use).toBe(true);
    v = editLogin(v, "user1", { password: "p" });
    expect(v.logins.user1.use).toBe(true);
  });

  it("trims the selection when the depth changes, and picks one when it needs one", () => {
    let v = valid();
    v.logins.admin = login({ username: "a" });
    v.logins.user2 = login({ username: "c" });
    v = fitLogins(v, "siege");
    expect(usedLogins(v)).toEqual(["admin", "user1", "user2"]);
    v = fitLogins(v, "probe");
    expect(usedLogins(v)).toEqual(["admin", "user1"]);
    v = fitLogins(v, "sweep");
    expect(usedLogins(v)).toEqual(["admin"]);
    v = fitLogins(v, "scout");
    expect(usedLogins(v)).toEqual([]);
    v = fitLogins(v, "sweep");
    expect(usedLogins(v)).toEqual(["admin"]);
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

describe("request bodies", () => {
  it("sends a typed password and omits a saved one, so the server keeps it", () => {
    const v = valid();
    v.logins.admin = login({ username: "admin", description: "Admin", password: "", saved: true });
    const body = toTargetInput(v);
    expect(body.logins).toEqual({
      admin: { username: "admin", description: "Admin", notes: "" },
      user1: {
        username: "swarm-test-user1",
        description: "Standard customer",
        notes: "",
        password: "not-a-real-password",
      },
    });
    expect(body).toMatchObject({ appUrl: "https://staging.example.com", acknowledged: true });
  });

  it("leaves out a half-filled login at Scout instead of failing", () => {
    const v = { ...valid(), tier: "scout" as const };
    v.logins.admin = { ...blank(), username: "half-filled" };
    expect(Object.keys(toTargetInput(v).logins)).toEqual(["user1"]);
  });

  it("names the scan, picks the logins and falls back to the account email when notifications are off", () => {
    const v = {
      ...valid(),
      frequency: "weekly" as const,
      notifyOn: "never" as const,
      notifyEmail: "",
    };
    expect(defaultScanName(v)).toBe("Sweep weekly scan of staging.example.com");
    expect(toScanInput(v, "tgt_abcd1234", "owner@example.com")).toEqual({
      targetId: "tgt_abcd1234",
      name: "Sweep weekly scan of staging.example.com",
      tier: "sweep",
      frequency: "weekly",
      timezone: v.timezone,
      notifyEmail: "owner@example.com",
      notifyOn: "never",
      loginSlots: ["user1"],
    });
    expect(toScanInput({ ...v, name: "  Mine ", tier: "scout" }, "tgt_abcd1234").name).toBe("Mine");
    expect(toScanInput({ ...v, tier: "scout" }, "tgt_abcd1234").loginSlots).toEqual([]);
  });
});

describe("saved targets and scans", () => {
  const staging = MOCK_TARGETS[0]!;

  it("a saved target fills the form but never a password, and needs a fresh acknowledgement", () => {
    const v = withTarget({ ...emptyIntake("owner@example.com"), acknowledged: true }, staging);
    expect(v).toMatchObject({
      targetId: "tgt_staging01",
      appUrl: staging.appUrl,
      acknowledged: false,
      notifyEmail: "owner@example.com",
    });
    expect(v.logins.admin).toMatchObject({ saved: true, password: "", use: true });
    expect(v.logins.user1).toMatchObject({ saved: true, password: "", use: false });
    expect(JSON.stringify(v)).not.toMatch(/"password":"[^"]/);
    expect(validateIntake({ ...v, acknowledged: true, appUrl: staging.appUrl })).toEqual({});
  });

  it("choosing New target clears the target but keeps the scan settings", () => {
    const filled = withTarget(emptyIntake("owner@example.com"), staging);
    const cleared = withTarget({ ...filled, tier: "probe", name: "Mine" }, null);
    expect(cleared).toMatchObject({ targetId: null, appUrl: "", tier: "probe", name: "Mine" });
    expect(startedLogins(cleared)).toEqual([]);
  });

  it("editing a scan shows its settings and the logins it uses", () => {
    const weekly = MOCK_SCANS.find((s) => s.id === "scan_weekly01")!;
    const v = valuesFromScan(weekly, staging, "owner@example.com");
    expect(v).toMatchObject({
      targetId: "tgt_staging01",
      name: "Weekly review",
      tier: "probe",
      frequency: "weekly",
      timezone: "Australia/Sydney",
      notifyEmail: "security@example-shop.test",
    });
    expect(usedLogins(v)).toEqual(["admin", "user1"]);
  });
});
