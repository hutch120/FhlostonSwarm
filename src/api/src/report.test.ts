import { readFileSync } from "node:fs";
import { renderPdf, chromiumAvailable } from "@swarm/agents";
import {
  DEMO_RUN_ID,
  applyEvents,
  buildReport,
  createRunState,
  replayEvents,
  summarise,
  tierRoster,
  type Finding,
  type RunEvent,
} from "@swarm/shared";
import { GUARDRAIL_IDS, INSTRUCTIONS_VERSION, type Engagement } from "@swarm/shared/server";
import { PDFParse } from "pdf-parse";
import { describe, expect, it, vi } from "vitest";
import { renderReportHtml } from "./report-html.js";

const browser = await chromiumAvailable();

const SECRETS = {
  password: "hunter2-secret-pw",
  cookie: "0f3a9c1b7d5e",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  aws: "AKIAIOSFODNN7EXAMPLE",
};

const poison = (s: string) =>
  `${s} password=${SECRETS.password} Cookie: sid=${SECRETS.cookie}; Authorization: Bearer ${SECRETS.jwt} key ${SECRETS.aws} also ${SECRETS.password}`;

function engagement(): Engagement {
  return {
    version: 1,
    runId: DEMO_RUN_ID,
    tier: "siege",
    instructionsVersion: INSTRUCTIONS_VERSION,
    guardrails: [...GUARDRAIL_IDS],
    scope: { hosts: ["portal.example"], readOnly: true },
    agents: tierRoster("siege").agents.map((a) => ({ id: a.id, enabled: true })),
    skippedChecks: [],
    roles: [{ slot: "admin", description: poison("Administrator"), kind: "admin" }],
    matrix: [],
    hints: { routes: [], apiBases: [], ai: [] },
    budget: { wallClockSeconds: 3600, maxSteps: 400, maxRequests: 3000, spendCapUsd: 15 },
    plannedBy: "rules",
    notes: [],
  };
}

/** The demo run's report, with secrets and markup planted in every field a run can fill. */
function plantedReport() {
  const events = replayEvents.map((e): RunEvent => {
    if (e.type === "finish" && e.payload.outcome === "info") {
      return { ...e, payload: { ...e.payload, note: poison(e.payload.note) } };
    }
    if (e.type === "gap")
      return { ...e, payload: { ...e.payload, reason: poison(e.payload.reason) } };
    if (e.type === "verify")
      return { ...e, payload: { ...e.payload, note: poison(e.payload.note) } };
    return e;
  });
  const { areas, agents } = tierRoster("siege");
  const state = applyEvents(
    createRunState({ runId: DEMO_RUN_ID, tier: "siege", areas, agents }),
    events,
  );
  const findings: Finding[] = state.findings.map((f, i) => ({
    ...f,
    title: i === 0 ? `<script>alert(1)</script> ${poison(f.title)}` : poison(f.title),
    description: poison(f.description),
    remediation: poison(f.remediation),
    evidence: [poison("evidence line")],
    reproduction: [poison("step one")],
    impact: poison("impact"),
  }));
  return buildReport({
    state: { ...state, findings },
    events,
    summary: summarise(state),
    target: "portal.example",
    generatedAt: events.at(-1)!.ts,
    engagement: engagement(),
    profile: {
      purpose: poison("A portal."),
      areas: [],
      roles: [],
      flows: [],
      technologies: [],
      coverage: { pagesVisited: 4, loginsUsed: 1, signedIn: true },
    },
    redact: { secrets: [SECRETS.password, SECRETS.cookie] },
  });
}

const headings = (html: string): string[] =>
  [...html.matchAll(/<h([234])[^>]*>(.*?)<\/h\1>/g)].map(
    (m) => `h${m[1]} ${m[2]!.replaceAll(/<[^>]+>/g, "")}`,
  );

describe("the HTML report", () => {
  const report = plantedReport();
  const html = renderReportHtml(report);

  it("has the sections of the example report, in order, with the gaps and priorities added", () => {
    const sections = [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((m) => m[1]);
    expect(sections).toEqual([
      "1. Executive summary",
      "2. Positive findings and effective controls",
      "3. Scope and methodology",
      "4. Testing performed",
      "5. AI/LLM security testing",
      "6. Technical findings",
      "7. Static code analysis",
      "8. Informational observations",
      "9. Recommended priorities",
      "10. Scope limitations and what a deeper scan adds",
      "Disclaimer",
    ]);

    // Each of the example's nine sections has its counterpart.
    const example = readFileSync(
      new URL("../../../docs/example-report.html", import.meta.url),
      "utf8",
    );
    const normalise = (s: string) =>
      s
        .replaceAll("&amp;", "and")
        .replaceAll("&", "and")
        .replace(/^\d+\.\s*/, "")
        .replace(/[^a-z0-9/ ]/gi, "")
        .toLowerCase()
        .trim();
    const exampleSections = [...example.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((m) =>
      normalise(m[1]!),
    );
    expect(exampleSections).toHaveLength(9);
    const ours = sections.map((s) => normalise(s!));
    for (const title of exampleSections) {
      expect(
        ours.some((o) => o.startsWith(title.split(" and ")[0]!) || o === title),
        title,
      ).toBe(true);
    }
  });

  it("outlines the testing performed phase by phase, and each finding in full", () => {
    const outline = headings(html);
    expect(outline).toEqual(
      expect.arrayContaining([
        "h3 Phase 1 &mdash; Recon",
        "h4 AI/LLM testing outcome",
        "h4 Key risks",
        "h4 Severity ratings",
        "h4 Description",
        "h4 Impact",
        "h4 Evidence",
        "h4 How to reproduce",
        "h4 Recommendation",
        "h4 Independent re-test",
      ]),
    );
    expect(html.match(/<article class="finding"/g)).toHaveLength(report.findings.length);
    expect(html).toContain("Instruction modules");
    expect(html).toContain(INSTRUCTIONS_VERSION);
  });

  it("marks verified and unconfirmed findings differently", () => {
    expect(html).toContain('<span class="tag tag-ok">verified</span>');
    expect(html).toContain('<span class="tag tag-warn">unconfirmed</span>');
  });

  it("is self-contained, escapes everything and never carries a planted secret", () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("default-src 'none'");
    for (const [name, secret] of Object.entries(SECRETS)) expect(html, name).not.toContain(secret);
    expect(html).toContain("[redacted]");
  });
});

describe.skipIf(!browser)("the PDF report", () => {
  vi.setConfig({ testTimeout: 60_000 });

  it("renders from the HTML, opens, shows the sections and carries no secret", async () => {
    const report = plantedReport();
    const pdf = await renderPdf(renderReportHtml(report));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.subarray(-16).toString("latin1")).toContain("%%EOF");

    const parser = new PDFParse({ data: new Uint8Array(pdf) });
    try {
      const { text, total } = await parser.getText();
      expect(total).toBeGreaterThan(1);
      for (const title of [
        "Executive summary",
        "Technical findings",
        "Recommended priorities",
        "Disclaimer",
      ]) {
        expect(text).toContain(title);
      }
      expect(text).toContain(report.findings[0]!.id);
      for (const [name, secret] of Object.entries(SECRETS))
        expect(text, name).not.toContain(secret);
    } finally {
      await parser.destroy();
    }
  });

  it("never reaches a network, whatever the HTML asks for", async () => {
    const pdf = await renderPdf(
      '<html><body><h1>Hello</h1><img src="http://evil.example/x.png"><link rel="stylesheet" href="https://evil.example/s.css"></body></html>',
    );
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
