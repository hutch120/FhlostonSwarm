import { SEVERITIES, tiers, type ReportFinding, type RunReport } from "@swarm/shared";

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const e = escapeHtml;

/** One stylesheet for screen and print: light, with page breaks that keep a finding together. */
const STYLE = `
*{box-sizing:border-box}
body{font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:#f4f6fb;color:#16203a}
main{max-width:58rem;margin:0 auto;padding:2rem 1.5rem 4rem;background:#fff}
.cover{border-bottom:4px solid #2d3fb5;padding:1.5rem 0 1.25rem;margin-bottom:1rem}
.cover h1{font-size:1.9rem;margin:0 0 .35rem}
.cover p{margin:.15rem 0;color:#4a5578}
h2{font-size:1.25rem;margin:2.2rem 0 .7rem;padding-bottom:.3rem;border-bottom:1px solid #d5dbee;color:#1b2a6b}
h3{font-size:1.02rem;margin:1.2rem 0 .3rem}
h4{font-size:.78rem;margin:.9rem 0 .15rem;text-transform:uppercase;letter-spacing:.06em;color:#4a5578}
p{margin:.35rem 0}
ul,ol{margin:.35rem 0;padding-left:1.3rem}
code{background:#eef1fa;padding:.08rem .3rem;border-radius:3px;font-size:.92em;word-break:break-all}
.muted{color:#5d6788}
.sev{display:flex;gap:.6rem;flex-wrap:wrap;list-style:none;padding:0;margin:.6rem 0}
.sev li{border:1px solid #d5dbee;border-radius:8px;padding:.45rem .9rem;min-width:5.2rem;text-align:center;background:#f8f9fd}
.sev b{display:block;font-size:1.35rem}
.badge{display:inline-block;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:.12rem .5rem;border-radius:999px;color:#fff;vertical-align:middle}
.b-critical{background:#b91c1c}.b-high{background:#c2410c}.b-medium{background:#a16207}.b-low{background:#0369a1}.b-info{background:#64748b}
.tag{display:inline-block;font-size:.7rem;padding:.1rem .45rem;border-radius:999px;border:1px solid #b9c2e2;color:#3a4678;margin-left:.3rem}
.tag-ok{border-color:#15803d;color:#15803d}.tag-warn{border-color:#a16207;color:#a16207}
.finding{border:1px solid #d5dbee;border-left-width:6px;border-radius:8px;padding:.8rem 1.1rem;margin:0 0 1.1rem;break-inside:avoid}
.finding[data-sev=critical]{border-left-color:#b91c1c}.finding[data-sev=high]{border-left-color:#c2410c}
.finding[data-sev=medium]{border-left-color:#ca8a04}.finding[data-sev=low]{border-left-color:#0284c7}
.finding[data-sev=info]{border-left-color:#94a3b8}
.finding h3{margin:0 0 .35rem}
.evidence{background:#f4f6fb;border-radius:6px;padding:.4rem .7rem;margin:.2rem 0}
table{border-collapse:collapse;width:100%;margin:.5rem 0;font-size:.92em}
th,td{border:1px solid #d5dbee;padding:.3rem .55rem;text-align:left;vertical-align:top}
th{background:#eef1fa}
tr{break-inside:avoid}
.note{border:1px solid #d5dbee;border-radius:8px;padding:.7rem 1rem;background:#f8f9fd}
.out-clear{color:#15803d}.out-finding{color:#b91c1c;font-weight:600}.out-gap,.out-not-run{color:#a16207}.out-info,.out-not-applicable{color:#4a5578}
@media print{body{background:#fff}main{max-width:none;padding:0}h2{break-after:avoid}}
`;

const OUTCOME_LABEL: Record<string, string> = {
  clear: "Passed",
  info: "Observation",
  finding: "Finding",
  gap: "Not tested",
  "not-applicable": "Not applicable",
  "not-run": "Not run",
};

const list = (items: string[]): string => (items.length ? `<ul>${items.join("")}</ul>` : "");

const badge = (severity: string) => `<span class="badge b-${e(severity)}">${e(severity)}</span>`;

function renderFinding(f: ReportFinding): string {
  const status =
    f.status === "unconfirmed"
      ? '<span class="tag tag-warn">unconfirmed</span>'
      : f.verified
        ? '<span class="tag tag-ok">verified</span>'
        : '<span class="tag">not cross-checked</span>';
  return `<article class="finding" data-sev="${e(f.severity)}" id="${e(f.id)}">
<h3>${e(f.id)} · ${e(f.title)}</h3>
<p>${badge(f.severity)} ${status} <span class="muted">${e(f.agent)}${f.mapping ? ` · ${e(f.mapping)}` : ""}</span></p>
<p><strong>Affected:</strong> <code>${e(f.component)}</code></p>
<h4>Description</h4><p>${e(f.description)}</p>
${f.impact ? `<h4>Impact</h4><p>${e(f.impact)}</p>` : ""}
${f.evidence?.length ? `<h4>Evidence</h4><div class="evidence">${list(f.evidence.map((x) => `<li>${e(x)}</li>`))}</div>` : ""}
${f.reproduction?.length ? `<h4>How to reproduce</h4><ol>${f.reproduction.map((x) => `<li>${e(x)}</li>`).join("")}</ol>` : ""}
<h4>Recommendation</h4><p>${e(f.remediation)}</p>
<h4>Independent re-test</h4><p class="muted">${e(f.verification.note)}</p>
</article>`;
}

/**
 * A self-contained HTML report (no scripts, no external requests) with the sections of the example
 * report (docs/example-report.html). Every value from the run is escaped, and the data has already
 * been through the redaction pass. The same markup is rendered to PDF.
 */
export function renderReportHtml(report: RunReport): string {
  const { summary, counts } = report;
  const tier = tiers[report.tier];
  const minutes = Math.max(1, Math.round(summary.durationMs / 60000));
  const bySeverity = SEVERITIES.map((s) => `<li><b>${counts.bySeverity[s] ?? 0}</b>${s}</li>`).join(
    "",
  );
  const serious = report.findings.filter((f) => f.severity === "critical" || f.severity === "high");

  const risks = serious.length
    ? list(
        serious
          .slice(0, 5)
          .map(
            (f) =>
              `<li>${badge(f.severity)} <a href="#${e(f.id)}">${e(f.id)}</a> ${e(f.title)}</li>`,
          ),
      )
    : '<p class="muted">No critical or high severity finding was raised by the checks that ran.</p>';

  const profile = report.profile;
  const understood = profile
    ? `<p>${e(profile.purpose)}</p>
<p class="muted">Described from ${profile.coverage.pagesVisited} pages${profile.coverage.signedIn ? `, including the signed-in side (${profile.coverage.loginsUsed} ${profile.coverage.loginsUsed === 1 ? "login" : "logins"})` : ", signed out"}. This is the scan's reading of what it saw, not a statement from the application's owner.</p>
${profile.areas.length ? `<h4>Areas and features</h4>${list(profile.areas.map((a) => `<li><strong>${e(a.name)}</strong>${a.path ? ` <code>${e(a.path)}</code>` : ""}${a.requiresLogin ? ' <span class="muted">(signed in)</span>' : ""}: ${e(a.description)}</li>`))}` : ""}
${profile.roles.length ? `<h4>Roles</h4>${list(profile.roles.map((r) => `<li><strong>${e(r.name)}</strong>: ${e(r.description)}${r.access.length ? ` Reaches: ${r.access.map(e).join(", ")}.` : ""}</li>`))}` : ""}
${profile.flows.length ? `<h4>Main flows</h4>${list(profile.flows.map((f) => `<li><strong>${e(f.name)}</strong>: ${e(f.description)}</li>`))}` : ""}
${profile.technologies.length ? `<h4>Technologies seen</h4><p>${profile.technologies.map(e).join(", ")}</p>` : ""}`
    : '<p class="muted">The scan could not build a description of the application.</p>';

  const plan = report.plan
    ? `<p>The engagement was planned from what discovery found${report.plan.plannedBy === "model" ? ", with a model refining the plan inside fixed guardrails" : ""}. Guardrails that no plan can change: only the declared hosts, read-only requests, nothing destructive, target content treated as data, no credentials in output, only the supplied logins, and the depth's limits.</p>
${report.plan.roles.length ? `<h4>Roles tested</h4>${list(report.plan.roles.map((r) => `<li><code>${e(r.slot)}</code> ${e(r.description)} <span class="muted">(read as ${e(r.kind)})</span></li>`))}` : ""}
${report.plan.notApplicable.length ? `<h4>Not applicable</h4>${list(report.plan.notApplicable.map((n) => `<li><strong>${e(n.name)}${n.step ? ` (${e(n.step)})` : ""}</strong>: ${e(n.reason)}</li>`))}` : ""}
${report.plan.notes.length ? list(report.plan.notes.map((n) => `<li>${e(n)}</li>`)) : ""}`
    : "";

  const learned =
    report.dynamic && report.dynamic.items.length + report.dynamic.agents.length > 0
      ? `<h4>Learned knowledge used</h4>
<p class="muted">The methodology also draws on items and checks that earlier scans and public sources added (version ${report.dynamic.version}). Entries marked as observing only were run in shadow and raised nothing.</p>
${list([
  ...report.dynamic.items.map(
    (i) =>
      `<li><strong>${e(i.title)}</strong> <span class="muted">(${i.mode === "active" ? "item" : "item, observing only"}; ${e(i.source.name)}, ${e(i.source.date)})</span></li>`,
  ),
  ...report.dynamic.agents.map(
    (a) =>
      `<li><strong>${e(a.title)}</strong> <span class="muted">(${a.mode === "active" ? "check" : "check, observing only"}; ${e(a.source.name)}, ${e(a.source.date)})</span></li>`,
  ),
])}`
      : "";

  const phases = report.phases
    .map(
      (p) => `<h3>Phase ${p.phase} &mdash; ${e(p.name)}</h3>
<p class="muted">${e(p.summary)}</p>
<table><thead><tr><th>Agent</th><th>Check</th><th>Result</th></tr></thead><tbody>
${p.checks
  .map(
    (c) =>
      `<tr><td>${e(c.agentName)}</td><td>${e(c.label)}</td><td class="out-${e(c.outcome)}">${e(OUTCOME_LABEL[c.outcome] ?? c.outcome)}${c.outcome === "gap" || c.outcome === "not-applicable" ? `<br><span class="muted">${e(c.detail ?? "")}</span>` : c.outcome === "finding" && c.detail ? ` <a href="#${e(c.detail)}">${e(c.detail)}</a>` : ""}</td></tr>`,
  )
  .join("\n")}
</tbody></table>`,
    )
    .join("\n");

  const findings =
    report.findings.length === 0
      ? '<p class="muted">No findings were raised by the checks that ran.</p>'
      : report.findings.map(renderFinding).join("\n");

  const priorities =
    report.priorities.length === 0
      ? '<p class="muted">Nothing needs fixing from this scan.</p>'
      : `<ol>${report.priorities
          .map(
            (p) =>
              `<li>${badge(p.severity)} <a href="#${e(p.findingId)}">${e(p.findingId)}</a> ${e(p.title)}${p.confirmed ? "" : ' <span class="tag tag-warn">unconfirmed</span>'}<br><span class="muted">${e(p.action)}</span></li>`,
          )
          .join("")}</ol>`;

  const limitations = [
    ...report.gaps.map((g) => `<li>${e(g.reason)}</li>`),
    ...report.notRun.map(
      (n) => `<li><strong>${e(n.name)}</strong> did not finish: ${e(n.reason)}</li>`,
    ),
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Swarm report: ${e(report.target)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<section class="cover">
<h1>Security assessment: ${e(report.target)}</h1>
<p>${e(tier.name)} scan · run ${e(report.runId)} · generated ${e(report.generatedAt)} · status ${e(report.status)}</p>
<p>Automated, AI-assisted assessment. Instruction modules ${e(report.instructionsVersion)}.</p>
</section>

<h2 id="summary">1. Executive summary</h2>
<ul class="sev">${bySeverity}</ul>
<p>${counts.total} ${counts.total === 1 ? "finding" : "findings"} from ${summary.checks} checks in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}${counts.total > 0 ? `; ${counts.verified} confirmed by an independent re-test${counts.unconfirmed > 0 ? `, ${counts.unconfirmed} unconfirmed` : ""}` : ""}. Coverage of the planned work: ${Math.round(summary.coverage * 100)}%. ${summary.gaps} scope ${summary.gaps === 1 ? "limitation is" : "limitations are"} listed in section 10.</p>
<h4>AI/LLM testing outcome</h4>
<p>${e(report.ai.summary)}</p>
<h4>Key risks</h4>
${risks}

<h2 id="positives">2. Positive findings and effective controls</h2>
${
  report.passed.length === 0
    ? '<p class="muted">No check completed without a finding.</p>'
    : list(
        report.passed.map(
          (p) => `<li>${e(p.label)} <span class="muted">(${e(p.agent)})</span></li>`,
        ),
      )
}

<h2 id="scope">3. Scope and methodology</h2>
<p>Target <code>${e(report.target)}</code>, scan depth <strong>${e(tier.name)}</strong>: ${e(tier.description)} All requests went through a scope guard that only allows the declared hosts, refuses private and metadata addresses, and was read-only for this run: only the sign-in submissions changed any state.</p>
${plan}
${learned}
<h4>Severity ratings</h4>
<p class="muted">Critical: exploitable now with severe impact. High: serious weakness with a realistic attack. Medium: weakness that needs another condition. Low: hardening gap. Info: observation.</p>
<h4>What we understood about the application</h4>
${understood}

<h2 id="tests">4. Testing performed</h2>
${phases}

<h2 id="ai">5. AI/LLM security testing</h2>
<p>${e(report.ai.summary)}</p>
${report.ai.findings.length ? list(report.ai.findings.map((id) => `<li><a href="#${e(id)}">${e(id)}</a> ${e(report.findings.find((f) => f.id === id)?.title ?? "")}</li>`)) : ""}

<h2 id="findings">6. Technical findings</h2>
${findings}

<h2 id="whitebox">7. Static code analysis</h2>
<p class="muted">Not applicable: no source code was supplied for this scan.</p>

<h2 id="info">8. Informational observations</h2>
${
  report.notes.length === 0
    ? '<p class="muted">Nothing to add.</p>'
    : list(report.notes.map((n) => `<li><strong>${e(n.label)}.</strong> ${e(n.note)}</li>`))
}

<h2 id="priority">9. Recommended priorities</h2>
${priorities}

<h2 id="limits">10. Scope limitations and what a deeper scan adds</h2>
${limitations.length === 0 ? '<p class="muted">No scope limitation was recorded.</p>' : list(limitations)}
<h4>Not included at this depth</h4>
${
  report.notIncluded.length === 0
    ? '<p class="muted">This depth runs every agent.</p>'
    : `<p class="muted">A deeper scan adds these checks.</p>${list(
        report.notIncluded.map((n) => `<li><strong>${e(n.name)}</strong>: ${e(n.covers)}</li>`),
      )}`
}

<h2 id="disclaimer">Disclaimer</h2>
<p class="note">${e(report.disclaimer)}</p>
</main>
</body>
</html>
`;
}
