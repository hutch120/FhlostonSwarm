import {
  FREQUENCY_LABELS,
  LOGIN_SLOT_IDS,
  frequencySchema,
  notifyOnSchema,
  tierIdSchema,
  tiers,
  type Frequency,
  type LoginSlotId,
  type NotifyOn,
  type ScanSummary,
  type TargetView,
  type TierId,
} from "@swarm/shared";
import { z } from "zod";

export type { LoginSlotId };

export const LOGIN_SLOTS: readonly { id: LoginSlotId; label: string; hint: string }[] = [
  { id: "admin", label: "Admin", hint: "Full administrative access." },
  { id: "user1", label: "User 1", hint: "A normal user." },
  {
    id: "user2",
    label: "User 2",
    hint: "A second normal user, which enables horizontal-escalation tests.",
  },
  { id: "other", label: "Other", hint: "Different permissions: read-only, manager, support…" },
];

export interface LoginValues {
  username: string;
  /** Empty when the saved password is kept (`saved`) or none has been entered yet. */
  password: string;
  description: string;
  notes: string;
  /** Whether this scan signs in with the login. The target keeps every login it has. */
  use: boolean;
  /** A password for this login is already saved on the server and is never sent back. */
  saved: boolean;
}

export interface IntakeValues {
  /** The saved target being reused or edited; null creates a new one. */
  targetId: string | null;
  /** Optional: a default is made from the depth, schedule and host. */
  name: string;
  appUrl: string;
  marketingUrl: string;
  /** How deep to scan: a group of agents (scout is shallowest, siege deepest). */
  tier: TierId;
  /** One-off, or how often the scan repeats. */
  frequency: Frequency;
  /** IANA zone the schedule runs in. */
  timezone: string;
  notifyEmail: string;
  notifyOn: NotifyOn;
  logins: Record<LoginSlotId, LoginValues>;
  scopeNotes: string;
  acknowledged: boolean;
}

const emptyLogin = (): LoginValues => ({
  username: "",
  password: "",
  description: "",
  notes: "",
  use: false,
  saved: false,
});

const emptyLogins = (): IntakeValues["logins"] => ({
  admin: emptyLogin(),
  user1: emptyLogin(),
  user2: emptyLogin(),
  other: emptyLogin(),
});

const browserTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/** `accountEmail` pre-fills the notification address; the customer can change it. */
export const emptyIntake = (accountEmail = ""): IntakeValues => ({
  targetId: null,
  name: "",
  appUrl: "",
  marketingUrl: "",
  tier: "sweep",
  frequency: "once",
  timezone: browserTimezone(),
  notifyEmail: accountEmail,
  notifyOn: "always",
  logins: emptyLogins(),
  scopeNotes: "",
  acknowledged: false,
});

/** Replaces the target fields with a saved target's, keeping the scan settings. Passwords stay on the server. */
export function withTarget(values: IntakeValues, target: TargetView | null): IntakeValues {
  if (!target) {
    const fresh = emptyIntake();
    return {
      ...values,
      targetId: null,
      appUrl: "",
      marketingUrl: "",
      scopeNotes: "",
      logins: fresh.logins,
      acknowledged: false,
    };
  }
  const logins = emptyLogins();
  for (const slot of LOGIN_SLOT_IDS) {
    const saved = target.logins[slot];
    if (saved) {
      logins[slot] = {
        username: saved.username,
        password: "",
        description: saved.description,
        notes: saved.notes,
        use: false,
        saved: true,
      };
    }
  }
  return fitLogins(
    {
      ...values,
      targetId: target.id,
      appUrl: target.appUrl,
      marketingUrl: target.marketingUrl,
      scopeNotes: target.scopeNotes,
      logins,
      acknowledged: false,
    },
    values.tier,
  );
}

/** The form for editing a saved scan: its target, settings and the logins it uses. */
export function valuesFromScan(
  scan: ScanSummary,
  target: TargetView | undefined,
  accountEmail: string,
): IntakeValues {
  const base: IntakeValues = {
    ...withTarget(emptyIntake(accountEmail), target ?? null),
    name: scan.name,
    tier: scan.tier,
    frequency: scan.frequency,
    timezone: scan.timezone,
    notifyEmail: scan.notifyEmail,
    notifyOn: scan.notifyOn,
  };
  const logins = { ...base.logins };
  for (const slot of LOGIN_SLOT_IDS) {
    logins[slot] = { ...logins[slot], use: scan.loginSlots.includes(slot) };
  }
  return { ...base, logins };
}

const isStarted = (login: LoginValues) =>
  login.saved || [login.username, login.password, login.description].some((v) => v.trim());

/** The logins the customer has started filling in or has saved. */
export const startedLogins = (values: IntakeValues): LoginSlotId[] =>
  LOGIN_SLOT_IDS.filter((slot) => isStarted(values.logins[slot]));

/** The logins this scan signs in with. */
export const usedLogins = (values: IntakeValues): LoginSlotId[] =>
  startedLogins(values).filter((slot) => values.logins[slot].use);

/** Switches depth, keeping the selected logins within what the new depth uses. */
export function fitLogins(values: IntakeValues, tier: TierId): IntakeValues {
  const allowed = tiers[tier].logins;
  let keep = usedLogins(values).slice(0, allowed);
  if (keep.length === 0 && allowed > 0) keep = startedLogins(values).slice(0, 1);
  const logins = { ...values.logins };
  for (const slot of LOGIN_SLOT_IDS) logins[slot] = { ...logins[slot], use: keep.includes(slot) };
  return { ...values, tier, logins };
}

/** Edits one login. A login that becomes started is selected for the scan while the depth has room. */
export function editLogin(
  values: IntakeValues,
  slot: LoginSlotId,
  patch: Partial<LoginValues>,
): IntakeValues {
  const before = values.logins[slot];
  const next = { ...before, ...patch };
  if (!isStarted(before) && isStarted(next) && patch.use === undefined) {
    next.use = usedLogins(values).length < tiers[values.tier].logins;
  }
  return { ...values, logins: { ...values.logins, [slot]: next } };
}

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
  name: z.string().trim().max(80, "Use 80 characters or fewer"),
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

  if (values.notifyOn !== "never" && !z.email().safeParse(values.notifyEmail.trim()).success) {
    errors["notifyEmail"] = "Enter the email address that should receive the report notice";
  }

  const tier = tiers[values.tier] as (typeof tiers)[TierId] | undefined;
  if (!tier || tier.logins === 0) return errors;

  // Every login the target will hold must be complete, used by this scan or not.
  const started = startedLogins(values);
  for (const slot of started) {
    const login = values.logins[slot];
    if (!login.username.trim()) errors[`login.${slot}.username`] = "Username is required";
    if (!login.password && !login.saved) errors[`login.${slot}.password`] = "Password is required";
    if (!login.description.trim())
      errors[`login.${slot}.description`] = "Describe what this account can do";
  }
  const used = usedLogins(values).length;
  if (used === 0) {
    errors["logins"] = `${tier.name} signs in as a test user: add at least one login and use it.`;
  } else if (used > tier.logins) {
    errors["logins"] =
      `${tier.name} uses up to ${tier.logins} login${tier.logins === 1 ? "" : "s"} and ` +
      `${used} are selected. Untick ${used - tier.logins} or choose a deeper scan.`;
  }
  return errors;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url.trim()).hostname;
  } catch {
    return "";
  }
};

/** The name used when the customer leaves it blank. */
export const defaultScanName = (values: IntakeValues): string =>
  `${tiers[values.tier].name} ${FREQUENCY_LABELS[values.frequency].toLowerCase()} scan of ${hostOf(values.appUrl)}`.slice(
    0,
    80,
  );

/** The target as the API takes it. A saved password is left out so the server keeps it. */
export function toTargetInput(values: IntakeValues) {
  const logins: Record<string, unknown> = {};
  for (const slot of startedLogins(values)) {
    const login = values.logins[slot];
    const complete =
      login.username.trim() && login.description.trim() && (login.password || login.saved);
    if (!complete) continue;
    logins[slot] = {
      username: login.username.trim(),
      description: login.description.trim(),
      notes: login.notes.trim(),
      ...(login.password ? { password: login.password } : {}),
    };
  }
  return {
    appUrl: values.appUrl.trim(),
    marketingUrl: values.marketingUrl.trim(),
    scopeNotes: values.scopeNotes.trim(),
    logins,
    acknowledged: true,
  };
}

/** The scan as the API takes it. `fallbackEmail` stands in for a blank address when notifications are off. */
export function toScanInput(values: IntakeValues, targetId: string, fallbackEmail = "") {
  return {
    targetId,
    name: values.name.trim() || defaultScanName(values),
    tier: values.tier,
    frequency: values.frequency,
    timezone: values.timezone,
    notifyEmail: values.notifyEmail.trim() || fallbackEmail,
    notifyOn: values.notifyOn,
    loginSlots: tiers[values.tier].logins === 0 ? [] : usedLogins(values),
  };
}
