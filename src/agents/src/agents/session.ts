import { headerValues } from "../http.js";
import type { BrowserCookie } from "../explorer/driver.js";
import type { AgentModule, ReplayResult, StepContext, StepResult } from "../types.js";
import { gap, pathOnTarget, requestAs } from "./support.js";

const SESSION_NAME = /sess|sid|token|auth|jwt|login/i;
/** Under this many bits of randomness an identifier can be guessed or enumerated. */
const MIN_BITS = 64;
const WEAK_BITS = 32;

interface Shape {
  length: number;
  charset: string;
  bits: number;
  jwt: boolean;
}

/** Describes a token by its length and alphabet. The value itself never leaves this function. */
export function shapeOf(value: string): Shape {
  const jwt = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(value);
  const perChar = /^[0-9]+$/.test(value)
    ? { charset: "digits", bits: Math.log2(10) }
    : /^[0-9a-f]+$/.test(value) || /^[0-9A-F]+$/.test(value)
      ? { charset: "hexadecimal characters", bits: 4 }
      : /^[a-z]+$/.test(value) || /^[A-Z]+$/.test(value)
        ? { charset: "letters of one case", bits: Math.log2(26) }
        : /^[A-Za-z0-9]+$/.test(value)
          ? { charset: "letters and digits", bits: Math.log2(62) }
          : { charset: "mixed characters", bits: 6 };
  // A run of one repeated character, or a counter, carries almost no randomness whatever its length.
  const distinct = new Set(value).size;
  const bits = distinct <= 2 ? distinct : value.length * perChar.bits;
  return { length: value.length, charset: perChar.charset, bits: Math.round(bits), jwt };
}

const sessionCookies = (cookies: BrowserCookie[]): BrowserCookie[] =>
  cookies.filter((c) => SESSION_NAME.test(c.name));

/** Cookies a fresh anonymous request is given: an independent sample from the same generator. */
async function anonymousSamples(ctx: StepContext): Promise<BrowserCookie[]> {
  const samples: BrowserCookie[] = [];
  for (let i = 0; i < 2; i += 1) {
    const res = await ctx.http.request({ url: ctx.appUrl.toString(), maxRedirects: 0 });
    for (const raw of headerValues(res, "set-cookie")) {
      const [pair, ...attrs] = raw.split(";");
      const eq = pair!.indexOf("=");
      if (eq <= 0) continue;
      samples.push({
        name: pair!.slice(0, eq).trim(),
        value: pair!.slice(eq + 1).trim(),
        secure: attrs.some((a) => /^\s*secure\s*$/i.test(a)),
        httpOnly: attrs.some((a) => /^\s*httponly\s*$/i.test(a)),
        sameSite: null,
      });
    }
  }
  return sessionCookies(samples);
}

const weakness = (s: Shape): string =>
  `${s.length} ${s.charset}, about ${s.bits} bits of randomness`;

async function token(ctx: StepContext): Promise<StepResult> {
  const signIns = (ctx.explorer?.signIns ?? []).filter((s) => s.ok);
  if (signIns.length === 0) {
    return gap("No sign-in succeeded, so the session identifier could not be inspected.");
  }
  const samples = signIns.flatMap((s) =>
    sessionCookies(s.cookies).map((c) => ({ slot: s.slot, cookie: c, shape: shapeOf(c.value) })),
  );
  if (samples.length === 0) {
    return {
      outcome: "info",
      note: "The sign-in did not set a cookie that looks like a session identifier (the application may keep its token elsewhere, which this check cannot see).",
    };
  }
  const weak = samples.filter((s) => !s.shape.jwt && s.shape.bits < MIN_BITS);
  if (weak.length === 0) return { outcome: "clear" };

  const worst = weak.reduce((a, b) => (b.shape.bits < a.shape.bits ? b : a));
  const names = [...new Set(weak.map((w) => w.cookie.name))];
  return {
    outcome: "finding",
    finding: {
      title: `Session identifier has low entropy (${worst.shape.bits} bits)`,
      severity: worst.shape.bits < WEAK_BITS ? "high" : "medium",
      component: `Session cookie ${names.join(", ")}`,
      description: `After signing in the application issues a session identifier of ${weakness(worst.shape)}. An identifier this small can be guessed or enumerated, which lets an attacker take over a signed-in session.`,
      remediation:
        "Generate session identifiers with a cryptographically secure random generator, at least 128 bits long, and expire them on sign-out and after a period of inactivity.",
      mapping: "OWASP A07:2021 Identification and Authentication Failures",
      evidence: weak
        .slice(0, 3)
        .map((w) => `Cookie ${w.cookie.name} as ${w.slot}: ${weakness(w.shape)}`),
      reproduction: [
        "Sign in and read the session cookie the application sets.",
        "Count its characters and work out the alphabet it uses.",
        "Repeat a few times: every identifier is short and drawn from a small space.",
      ],
      // A fresh anonymous request is an independent sample of the same generator; other logins are too.
      replay: async (): Promise<ReplayResult> => {
        const fresh = [
          ...(await anonymousSamples(ctx)),
          ...(ctx.explorer?.signIns ?? [])
            .filter((s) => s.ok)
            .flatMap((s) => sessionCookies(s.cookies)),
        ].filter((c) => names.includes(c.name));
        const independent = fresh.filter((c) => !weak.some((w) => w.cookie.value === c.value));
        if (independent.length === 0) {
          return {
            confirmed: null,
            note: "No second, independent sample of the identifier could be obtained, so the entropy could not be measured again.",
          };
        }
        const shapes = independent.map((c) => shapeOf(c.value));
        const low = shapes.filter((s) => s.bits < MIN_BITS).length;
        return {
          confirmed: low > 0,
          note: `Measured ${shapes.length} fresh identifier(s) from the same cookie: ${low} had under ${MIN_BITS} bits (${weakness(shapes[0]!)}).`,
        };
      },
    },
  };
}

async function fixation(ctx: StepContext): Promise<StepResult> {
  const signIns = (ctx.explorer?.signIns ?? []).filter((s) => s.ok);
  if (signIns.length === 0) {
    return gap("No sign-in succeeded, so the session identifier could not be compared across it.");
  }
  const kept: string[] = [];
  let compared = 0;
  for (const s of signIns) {
    for (const before of sessionCookies(s.before)) {
      const after = s.cookies.find((c) => c.name === before.name);
      if (!after) continue;
      compared += 1;
      if (after.value === before.value) kept.push(`${before.name} (${s.slot})`);
    }
  }
  if (compared === 0) {
    return {
      outcome: "info",
      note: "The application set no session cookie before sign-in, so whether the identifier is renewed at sign-in could not be compared.",
    };
  }
  if (kept.length === 0) return { outcome: "clear" };
  return {
    outcome: "finding",
    finding: {
      title: "Session identifier is not renewed at sign-in",
      severity: "medium",
      component: `Session cookie ${kept.join(", ")}`,
      description:
        "The identifier the browser held before signing in is still the identifier afterwards. An attacker who can plant a known identifier in a victim's browser (session fixation) can use it once the victim signs in.",
      remediation: "Issue a new session identifier when a user signs in and discard the old one.",
      mapping: "OWASP A07:2021 Identification and Authentication Failures",
      evidence: kept.map((k) => `The value of ${k} did not change across the sign-in.`),
      // The sign-in cannot be repeated on its own, so this one stays unconfirmed by design.
      replay: async () => ({
        confirmed: null,
        note: "The sign-in cannot be repeated without a second sign-in submission, so the observation was not re-tested.",
      }),
    },
  };
}

const LOGOUT = /log-?out|sign-?out/i;

async function logout(ctx: StepContext): Promise<StepResult> {
  const role = ctx.roles()[0];
  if (!role) return gap("No login held a session outside the browser, so sign-out was not tested.");
  const pages = ctx.explorer?.pagesFor(role.slot) ?? [];
  const link = pages
    .flatMap((p) => p.links)
    .map((l) => ({ text: l.text, path: pathOnTarget(ctx, l.href) }))
    .find((l) => l.path && (LOGOUT.test(l.text) || LOGOUT.test(l.path)));
  if (!link?.path) {
    return gap(
      "Signing out is done with a form post, a state-changing request that a read-only scan does not send, so server-side invalidation was not tested.",
    );
  }
  const landing = pages.map((p) => pathOnTarget(ctx, p.url)).find((p) => p && p !== link.path);
  if (!landing) return gap("No signed-in page was available to test the session with.");

  const before = await requestAs(ctx, role, landing);
  if (before?.access !== "allowed") {
    return gap(
      "The signed-in page was not reachable with the session, so sign-out was not tested.",
    );
  }
  await requestAs(ctx, role, link.path);
  const after = await requestAs(ctx, role, landing);
  if (after?.access !== "allowed") return { outcome: "clear" };
  return {
    outcome: "finding",
    finding: {
      title: "Session stays valid after signing out",
      severity: "medium",
      component: `GET ${link.path}`,
      description:
        "After the sign-out link was followed, the same session identifier still gave access to a signed-in page. Signing out only clears the browser; the session stays usable by anyone who has copied it.",
      remediation: "Invalidate the session on the server when the user signs out.",
      mapping: "OWASP A07:2021 Identification and Authentication Failures",
      evidence: [
        `GET ${landing} with the old session returned ${after.status} after ${link.path}.`,
      ],
      replay: async () => {
        const again = await requestAs(ctx, role, landing);
        return {
          confirmed: again?.access === "allowed",
          note: `Requested ${landing} again with the signed-out session: ${again?.status ?? "no answer"}.`,
        };
      },
    },
  };
}

export const sessionAgent: AgentModule = {
  id: "session",
  task: "Inspect how sessions are issued, renewed and ended",
  steps: { token, fixation, logout },
  doneSummary: ({ checks, findings }) =>
    `Session review finished: ${checks} checks, ${findings} ${findings === 1 ? "issue" : "issues"}.`,
};
