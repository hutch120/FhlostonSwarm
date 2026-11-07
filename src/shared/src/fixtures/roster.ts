import { areaSpecSchema, agentSpecSchema, type AgentSpec, type AreaSpec } from "../events.js";

/** The simulated roster: 5 areas and 12 agents (PLAN.md section 1), kept as data. */
const areas: AreaSpec[] = [
  {
    id: "recon",
    name: "Recon",
    summary: "DNS, WHOIS and certificate transparency; surface and bundle discovery.",
    colour: "#38bdf8",
    phase: 1,
  },
  {
    id: "unauth",
    name: "OWASP Top 10 & TLS",
    summary: "Unauthenticated web checks: transport, headers, scanner sweep and CORS.",
    colour: "#a3e635",
    phase: 2,
  },
  {
    id: "authn",
    name: "AuthN/AuthZ & API",
    summary: "Login, session handling and authorisation across the declared roles.",
    colour: "#f59e0b",
    phase: 3,
  },
  {
    id: "llm",
    name: "LLM Top 10",
    summary: "Prompt injection, output handling and other AI-feature risks.",
    colour: "#c084fc",
    phase: 4,
  },
  {
    id: "logic",
    name: "Logic / IDOR / privesc",
    summary: "Business-logic abuse, object-level access and privilege escalation.",
    colour: "#fb7185",
    phase: 5,
  },
];

const agents: AgentSpec[] = [
  {
    id: "dns",
    name: "DNS",
    area: "recon",
    colour: "#38bdf8",
    face: "visor",
    steps: [
      { id: "records", label: "Resolve A/AAAA/MX/TXT records" },
      { id: "whois", label: "WHOIS and registrar lock" },
      { id: "ct", label: "Certificate transparency sweep" },
      { id: "takeover", label: "Dangling CNAME / subdomain takeover" },
    ],
  },
  {
    id: "surface",
    name: "Surface",
    area: "recon",
    colour: "#22d3ee",
    face: "round",
    steps: [
      { id: "crawl", label: "Crawl public pages" },
      { id: "fingerprint", label: "Fingerprint server and framework" },
      { id: "robots", label: "robots.txt and sitemap review" },
      { id: "endpoints", label: "Enumerate API endpoints" },
    ],
  },
  {
    id: "bundle",
    name: "Bundle",
    area: "recon",
    colour: "#60a5fa",
    face: "hex",
    steps: [
      { id: "download", label: "Download JavaScript bundles" },
      { id: "secrets", label: "Scan bundles for secrets" },
      { id: "sourcemaps", label: "Check for exposed source maps" },
    ],
  },
  {
    id: "tls",
    name: "TLS",
    area: "unauth",
    colour: "#a3e635",
    face: "cyclops",
    steps: [
      { id: "protocols", label: "Negotiate protocol versions" },
      { id: "ciphers", label: "Review cipher suites" },
      { id: "chain", label: "Validate certificate chain" },
      { id: "hsts", label: "HSTS and redirect behaviour" },
    ],
  },
  {
    id: "zap",
    name: "Scanner",
    area: "unauth",
    colour: "#84cc16",
    face: "ears",
    steps: [
      { id: "headers", label: "Security headers audit" },
      { id: "passive", label: "Passive scan of crawled pages" },
      { id: "cookies", label: "Cookie attribute review" },
      { id: "errors", label: "Error handling and stack traces" },
    ],
  },
  {
    id: "cors",
    name: "CORS",
    area: "unauth",
    colour: "#4ade80",
    face: "round",
    steps: [
      { id: "preflight", label: "Probe preflight responses" },
      { id: "origin", label: "Test reflected and null origins" },
      { id: "credentials", label: "Check credentialed cross-origin access" },
    ],
  },
  {
    id: "authn",
    name: "Login",
    area: "authn",
    colour: "#f59e0b",
    face: "visor",
    steps: [
      { id: "login", label: "Sign in with each declared role" },
      { id: "lockout", label: "Brute-force and lockout behaviour" },
      { id: "reset", label: "Password reset flow" },
      { id: "mfa", label: "MFA enforcement" },
    ],
  },
  {
    id: "session",
    name: "Session",
    area: "authn",
    colour: "#fbbf24",
    face: "hex",
    steps: [
      { id: "token", label: "Inspect session token entropy" },
      { id: "fixation", label: "Session fixation and rotation" },
      { id: "logout", label: "Logout and server-side invalidation" },
    ],
  },
  {
    id: "authz",
    name: "Access",
    area: "authn",
    colour: "#fb923c",
    face: "cyclops",
    steps: [
      { id: "matrix", label: "Build role/endpoint access matrix" },
      { id: "vertical", label: "Vertical privilege checks" },
      { id: "admin", label: "Admin endpoint exposure" },
      { id: "methods", label: "HTTP method tampering" },
    ],
  },
  {
    id: "prompt",
    name: "Prompt",
    area: "llm",
    colour: "#c084fc",
    face: "ears",
    steps: [
      { id: "discover", label: "Locate AI features" },
      { id: "injection", label: "Direct prompt injection" },
      { id: "leak", label: "System prompt disclosure" },
    ],
  },
  {
    id: "output",
    name: "Output",
    area: "llm",
    colour: "#e879f9",
    face: "round",
    steps: [
      { id: "render", label: "Check model output rendering" },
      { id: "tools", label: "Tool and plugin permissions" },
      { id: "limits", label: "Token and rate limits" },
    ],
  },
  {
    id: "idor",
    name: "IDOR",
    area: "logic",
    colour: "#fb7185",
    face: "hex",
    steps: [
      { id: "ids", label: "Map object identifiers" },
      { id: "horizontal", label: "Horizontal access between users" },
      { id: "workflow", label: "Workflow step skipping" },
      { id: "export", label: "Bulk export and download paths" },
    ],
  },
];

export const AREAS: readonly AreaSpec[] = areas.map((a) => areaSpecSchema.parse(a));
export const AGENTS: readonly AgentSpec[] = agents.map((a) => agentSpecSchema.parse(a));

export const DEMO_TARGET = "portal.swarm-demo.test";
export const DEMO_RUN_ID = "run_demo0001";
