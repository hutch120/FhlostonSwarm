import {
  frequencySchema,
  notifyOnSchema,
  tierIdSchema,
  tiers,
  type Frequency,
  type NotifyOn,
  type TierId,
} from "@swarm/shared";
import { z } from "zod";

export const LOGIN_SLOTS = [
  { id: "admin", label: "Admin", hint: "Full administrative access." },
  { id: "user1", label: "User 1", hint: "A normal user." },
  {
    id: "user2",
    label: "User 2",
    hint: "A second normal user, which enables horizontal-escalation tests.",
  },
  { id: "other", label: "Other", hint: "Different permissions: read-only, manager, support…" },
] as const;

export type LoginSlotId = (typeof LOGIN_SLOTS)[number]["id"];
const slotIds = LOGIN_SLOTS.map((s) => s.id) as [LoginSlotId, ...LoginSlotId[]];

export interface LoginValues {
  username: string;
  password: string;
  description: string;
  notes: string;
}

export interface IntakeValues {
  appUrl: string;
  marketingUrl: string;
  /** How deep to scan: a group of agents (scout is shallowest, siege deepest). */
  tier: TierId;
  /** One-off, or how often the scan repeats. */
  frequency: Frequency;
  notifyEmail: string;
  notifyOn: NotifyOn;
  logins: Record<LoginSlotId, LoginValues>;
  scopeNotes: string;
  acknowledged: boolean;
}

const emptyLogin = (): LoginValues => ({ username: "", password: "", description: "", notes: "" });

/** `accountEmail` pre-fills the notification address; the customer can change it. */
export const emptyIntake = (accountEmail = ""): IntakeValues => ({
  appUrl: "",
  marketingUrl: "",
  tier: "sweep",
  frequency: "once",
  notifyEmail: accountEmail,
  notifyOn: "always",
  logins: { admin: emptyLogin(), user1: emptyLogin(), user2: emptyLogin(), other: emptyLogin() },
  scopeNotes: "",
  acknowledged: false,
});

const httpUrl = z
  .string()
  .trim()
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "https:" || u.protocol === "http:";
    } catch {
      return false;
    }
  }, "Enter a full URL starting with https:// (or http://)");

const intakeShape = z.object({
  appUrl: httpUrl,
  marketingUrl: z.union([z.literal(""), httpUrl]),
  tier: tierIdSchema,
  frequency: frequencySchema,
  notifyOn: notifyOnSchema,
  acknowledged: z.literal(true, "You must confirm you are authorised to test these systems"),
});

export type IntakeErrors = Record<string, string>;

const isStarted = (login: LoginValues) =>
  [login.username, login.password, login.description].some((v) => v.trim());

/** The logins the customer has started filling in. */
export const startedLogins = (values: IntakeValues): LoginSlotId[] =>
  slotIds.filter((slot) => isStarted(values.logins[slot]));

/** Field-level validation for the intake form. Keys are field names ("appUrl", "login.user1.password"). */
export function validateIntake(values: IntakeValues): IntakeErrors {
  const errors: IntakeErrors = {};
  const parsed = intakeShape.safeParse(values);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "form");
      errors[key] ??= issue.message;
    }
  }

  if (values.notifyOn !== "never" && !z.email().safeParse(values.notifyEmail.trim()).success) {
    errors["notifyEmail"] = "Enter the email address that should receive the report notice";
  }

  const tier = tiers[values.tier] as (typeof tiers)[TierId] | undefined;
  if (!tier || tier.logins === 0) return errors;

  const started = startedLogins(values);
  for (const slot of started) {
    const login = values.logins[slot];
    if (!login.username.trim()) errors[`login.${slot}.username`] = "Username is required";
    if (!login.password) errors[`login.${slot}.password`] = "Password is required";
    if (!login.description.trim())
      errors[`login.${slot}.description`] = "Describe what this account can do";
  }
  if (started.length === 0) {
    errors["logins"] = `${tier.name} signs in as a test user: add at least one login.`;
  } else if (started.length > tier.logins) {
    errors["logins"] =
      `${tier.name} uses up to ${tier.logins} login${tier.logins === 1 ? "" : "s"} and ` +
      `${started.length} are filled in. Clear ${started.length - tier.logins} or choose a deeper scan.`;
  }
  return errors;
}
