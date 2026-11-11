import { GUARDRAILS, INSTRUCTIONS_VERSION } from "@swarm/shared/server";

/**
 * The methodology as versioned prompt modules (PLAN.md section 8): each phase of docs/instructions
 * with an objective, the checks it covers, the tools it may use, how evidence is kept and the output
 * it produces. The guardrails are shared and immutable: every rendered module carries all of them,
 * and no module, plan or model output can remove one. Nothing here names a target, an account or a
 * path; the run supplies those. Bump `INSTRUCTIONS_VERSION` (shared) whenever this file changes.
 */
export interface InstructionModule {
  id: string;
  /** The methodology phase (1 to 6, as in docs/instructions). */
  phase: 1 | 2 | 3 | 4 | 5 | 6;
  title: string;
  objective: string;
  /** The roster checks this phase covers: agent id, step id and what the check looks for. */
  checks: { agent: string; step: string; looksFor: string }[];
  /** The typed tools the phase may use; there is never a raw shell. */
  tools: string[];
  /** What is kept as evidence, and what is never kept. */
  evidence: string;
  /** What the phase hands on. */
  output: string;
}

const READ_ONLY_TOOLS = ["scoped_get (GET, HEAD, OPTIONS through the scope proxy)"];

export const INSTRUCTION_MODULES: readonly InstructionModule[] = [
  {
    id: "reconnaissance",
    phase: 1,
    title: "Reconnaissance (unauthenticated)",
    objective:
      "Map the public attack surface without credentials: what the organisation exposes, what the pages and scripts reveal, and which software it runs.",
    checks: [
      { agent: "dns", step: "records", looksFor: "address, mail and text records, SPF and DMARC" },
      { agent: "dns", step: "whois", looksFor: "registrar lock and registration data" },
      { agent: "dns", step: "ct", looksFor: "hosts named in certificate transparency logs" },
      { agent: "dns", step: "takeover", looksFor: "aliases that point at services nobody owns" },
      { agent: "surface", step: "crawl", looksFor: "the pages reachable without signing in" },
      {
        agent: "surface",
        step: "fingerprint",
        looksFor: "server and framework names and versions",
      },
      { agent: "surface", step: "robots", looksFor: "robots.txt and sitemap hints" },
      { agent: "surface", step: "endpoints", looksFor: "API endpoints the pages refer to" },
      { agent: "bundle", step: "download", looksFor: "the JavaScript the application serves" },
      { agent: "bundle", step: "secrets", looksFor: "keys and credentials inside public scripts" },
      { agent: "bundle", step: "sourcemaps", looksFor: "source maps shipped to production" },
    ],
    tools: [...READ_ONLY_TOOLS, "dns_lookup (names the customer declared)", "browser.open_link"],
    evidence:
      "Keep short excerpts of what was seen (a header line, a path, a masked secret). Never keep a full secret.",
    output: "Findings for exposed information; observations for the application profile.",
  },
  {
    id: "vulnerability-assessment",
    phase: 2,
    title: "Unauthenticated vulnerability assessment",
    objective:
      "Check what any visitor can reach for weak transport security, missing protections and unsafe cross-origin access.",
    checks: [
      { agent: "tls", step: "protocols", looksFor: "plain HTTP and legacy protocol versions" },
      { agent: "tls", step: "ciphers", looksFor: "weak cipher suites" },
      { agent: "tls", step: "chain", looksFor: "an invalid or expiring certificate chain" },
      { agent: "tls", step: "hsts", looksFor: "HSTS and the redirect from HTTP" },
      { agent: "zap", step: "headers", looksFor: "missing security headers" },
      { agent: "zap", step: "passive", looksFor: "exposed repository metadata and files" },
      { agent: "zap", step: "cookies", looksFor: "cookies without protective attributes" },
      { agent: "zap", step: "errors", looksFor: "stack traces and verbose errors" },
      { agent: "cors", step: "preflight", looksFor: "state-changing methods allowed cross-origin" },
      { agent: "cors", step: "origin", looksFor: "reflected or null origins" },
      { agent: "cors", step: "credentials", looksFor: "credentialed cross-origin access" },
    ],
    tools: [...READ_ONLY_TOOLS, "tls_probe (handshakes through the scope proxy)"],
    evidence: "Keep the request line and the relevant response header or status, not whole bodies.",
    output: "Findings with severity and a fix for each.",
  },
  {
    id: "authenticated-testing",
    phase: 3,
    title: "Authenticated testing across roles",
    objective:
      "Sign in with each supplied login and test how sessions are issued and how access is enforced between roles.",
    checks: [
      {
        agent: "authn",
        step: "login",
        looksFor: "how the sign-in transports credentials and sets the session",
      },
      {
        agent: "authn",
        step: "lockout",
        looksFor: "brute-force protection (needs repeated sign-ins)",
      },
      { agent: "authn", step: "reset", looksFor: "the password reset flow" },
      { agent: "authn", step: "mfa", looksFor: "whether a second factor is asked for" },
      { agent: "session", step: "token", looksFor: "the strength of the session identifier" },
      { agent: "session", step: "fixation", looksFor: "an identifier kept across sign-in" },
      { agent: "session", step: "logout", looksFor: "server-side invalidation at sign-out" },
      { agent: "authz", step: "matrix", looksFor: "which role reaches which pages" },
      {
        agent: "authz",
        step: "vertical",
        looksFor: "a lower role reaching pages meant for a higher one",
      },
      {
        agent: "authz",
        step: "admin",
        looksFor: "administrative pages open to lower roles or visitors",
      },
      {
        agent: "authz",
        step: "methods",
        looksFor: "access granted through another request method",
      },
    ],
    tools: [
      ...READ_ONLY_TOOLS,
      "browser.sign_in (credentials are filled by code; the model never sees them)",
      "role_get (a safe request carrying one login's session)",
    ],
    evidence:
      "Describe a session identifier by its length and character set, never by its value. Never keep a password or cookie.",
    output: "Findings per role pair; the role access matrix as an observation.",
  },
  {
    id: "ai-llm-testing",
    phase: 4,
    title: "AI / LLM security testing",
    objective:
      "Where the application exposes a language-model feature that a safe request can reach, test whether it can be steered by injected instructions, discloses its configuration, or has its output used unsafely.",
    checks: [
      {
        agent: "prompt",
        step: "discover",
        looksFor: "places the application takes free text for a model",
      },
      { agent: "prompt", step: "injection", looksFor: "obeying instructions hidden in the input" },
      {
        agent: "prompt",
        step: "leak",
        looksFor: "disclosure of the system prompt or configuration",
      },
      {
        agent: "output",
        step: "render",
        looksFor: "model output rendered as markup without escaping",
      },
      { agent: "output", step: "tools", looksFor: "tools or actions the model can invoke" },
      { agent: "output", step: "limits", looksFor: "rate or size limits on the model feature" },
    ],
    tools: [...READ_ONLY_TOOLS],
    evidence:
      "Use harmless canary strings, and keep only the part of a reply that shows the behaviour. Never keep verbatim jailbreak output.",
    output:
      "Findings, or a recorded 'not applicable' when the application has no model feature a safe request can reach.",
  },
  {
    id: "business-logic",
    phase: 5,
    title: "Business logic and privilege escalation",
    objective:
      "Test whether one user can read another user's objects, and whether workflows and exports respect ownership.",
    checks: [
      {
        agent: "idor",
        step: "ids",
        looksFor: "object identifiers in links and API paths, by owner",
      },
      { agent: "idor", step: "horizontal", looksFor: "one user reading another user's objects" },
      {
        agent: "idor",
        step: "workflow",
        looksFor: "steps that can be skipped (needs state changes)",
      },
      {
        agent: "idor",
        step: "export",
        looksFor: "bulk export and download paths open to visitors",
      },
    ],
    tools: [...READ_ONLY_TOOLS, "role_get (a safe request carrying one login's session)"],
    evidence:
      "Say which role could read which kind of object. Never keep the other user's data beyond a masked excerpt.",
    output: "Findings for broken object-level access.",
  },
  {
    id: "reporting",
    phase: 6,
    title: "Reporting",
    objective:
      "Turn validated findings into the report. Numbers are computed from the findings; prose never adds a claim the evidence does not support.",
    checks: [],
    tools: [],
    evidence:
      "Passwords, tokens, cookies and personal addresses are scrubbed from everything the customer reads; raw evidence stays in the private run prefix.",
    output:
      "Executive summary, positive findings, scope and methodology, testing performed, AI/LLM testing, technical findings, informational notes and recommended priorities.",
  },
];

export const guardrailText = (): string =>
  GUARDRAILS.map((g, i) => `${i + 1}. ${g.text}`).join("\n");

/** One module as prompt text, always with every guardrail. */
export function renderModule(module: InstructionModule): string {
  return [
    `Phase ${module.phase}: ${module.title}`,
    `Objective: ${module.objective}`,
    `Guardrails (immutable):\n${guardrailText()}`,
    module.checks.length > 0
      ? `Checks:\n${module.checks.map((c) => `- ${c.agent}.${c.step}: ${c.looksFor}`).join("\n")}`
      : "Checks: none (this phase produces the report).",
    `Tools: ${module.tools.join("; ") || "none"}`,
    `Evidence: ${module.evidence}`,
    `Output: ${module.output}`,
  ].join("\n");
}

/** The modules for the phases a run covers, as prompt text. */
export function renderModules(agentIds: readonly string[]): string {
  const wanted = new Set(agentIds);
  return INSTRUCTION_MODULES.filter((m) => m.checks.some((c) => wanted.has(c.agent)))
    .map(renderModule)
    .join("\n\n");
}

export { INSTRUCTIONS_VERSION };
