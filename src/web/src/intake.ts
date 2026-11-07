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
  tier: "lite" | "full";
  liteSlot: LoginSlotId;
  logins: Record<LoginSlotId, LoginValues>;
  scopeNotes: string;
  acknowledged: boolean;
}

const emptyLogin = (): LoginValues => ({ username: "", password: "", description: "", notes: "" });

export const emptyIntake = (): IntakeValues => ({
  appUrl: "",
  marketingUrl: "",
  tier: "lite",
  liteSlot: "user1",
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
  tier: z.enum(["lite", "full"]),
  liteSlot: z.enum(slotIds),
  acknowledged: z.literal(true, "You must confirm you are authorised to test these systems"),
});

export type IntakeErrors = Record<string, string>;

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

  const required = (slot: LoginSlotId) => {
    const login = values.logins[slot];
    const entered = [login.username, login.password, login.description].some((v) => v.trim());
    const mustBeComplete = values.tier === "lite" ? slot === values.liteSlot : entered;
    if (!mustBeComplete) return;
    if (!login.username.trim()) errors[`login.${slot}.username`] = "Username is required";
    if (!login.password) errors[`login.${slot}.password`] = "Password is required";
    if (!login.description.trim())
      errors[`login.${slot}.description`] = "Describe what this account can do";
  };
  for (const slot of slotIds) required(slot);
  return errors;
}
