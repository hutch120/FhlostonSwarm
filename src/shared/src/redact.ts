/**
 * The redaction pass (PLAN.md section 10, phase-6-reporting.md): credentials, tokens, cookies and
 * personal addresses are scrubbed from everything a customer can read. Known secrets of the run
 * (the supplied passwords, session values) are removed exactly; patterns catch the rest.
 */

export const REDACTED = "[redacted]";

const MIN_SECRET_LENGTH = 4;

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  // `Cookie:` and `Set-Cookie:` header lines with name=value pairs, whatever the cookie is called.
  [/\b((?:set-)?cookie\s*:\s*)(?=[A-Za-z0-9_.-]+=)[^\r\n]+/gi, `$1${REDACTED}`],
  // name=value pairs for credential-like names (cookies, query strings, form bodies).
  [
    /\b([A-Za-z0-9_.-]*(?:sess(?:ion)?(?:id)?|sid|token|auth|jwt|passw(?:or)?d|pwd|secret|api[_-]?key)[A-Za-z0-9_.-]*)=([^\s;&"'<>]{3,})/gi,
    `$1=${REDACTED}`,
  ],
  // "password": "value" and password: value
  [
    /(["']?(?:passw(?:or)?d|pwd|secret|api[_-]?key|access[_-]?token|authorization)["']?\s*[:=]\s*)(["']?)[^\s"',;&<>]{3,}\2/gi,
    `$1$2${REDACTED}$2`,
  ],
];

const EMAIL = /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

const escapeRegExp = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface RedactOptions {
  /** Values to remove wherever they appear (passwords, session values). */
  secrets?: readonly string[];
  /** Also mask personal email addresses (`a***@example.com`). */
  emails?: boolean;
}

export function redactText(text: string, options: RedactOptions = {}): string {
  let out = text;
  const secrets = [...new Set(options.secrets ?? [])]
    .filter((s) => s.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    out = out.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
    // The same value as it appears URL-encoded.
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.replace(new RegExp(escapeRegExp(encoded), "g"), REDACTED);
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  if (options.emails) out = out.replace(EMAIL, "$1***@$2");
  return out;
}

/** Redacts every string in a JSON-like value (keys are left alone). */
export function redactDeep<T>(value: T, options: RedactOptions = {}): T {
  if (typeof value === "string") return redactText(value, options) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, options)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactDeep(v, options)]),
    ) as T;
  }
  return value;
}
