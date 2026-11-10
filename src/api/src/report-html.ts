import { SEVERITIES, tiers, type RunReport } from "@swarm/shared";

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const e = escapeHtml;

const STYLE = `
body{font:16px/1.55 system-ui,sans-serif;margin:0;background:#0b1020;color:#e6e9f2}
main{max-width:60rem;margin:0 auto;padding:2rem 1.25rem 4rem}
h1{font-size:1.8rem;margin:0 0 .25rem}h2{margin:2rem 0 .75rem;font-size:1.25rem;border-bottom:1px solid #2a3355;padding-bottom:.3rem}
.muted{color:#9aa3c0}code{background:#161d38;padding:.1rem .35rem;border-radius:4px}
.sev{display:flex;gap:.75rem;flex-wrap:wrap;list-style:none;padding:0}
.sev li{background:#161d38;border-radius:8px;padding:.5rem .9rem;min-width:5rem;text-align:center}
.sev b{display:block;font-size:1.4rem}
.finding{background:#121832;border:1px solid #2a3355;border-left-width:5px;border-radius:8px;padding:.9rem 1.1rem;margin:0 0 1rem}
.finding[data-sev=critical]{border-left-color:#ef4444}.finding[data-sev=high]{border-left-color:#f97316}
.finding[data-sev=medium]{border-left-color:#eab308}.finding[data-sev=low]{border-left-color:#38bdf8}
.finding[data-sev=info]{border-left-color:#94a3b8}
.finding h3{margin:0 0 .25rem;font-size:1.05rem}.badge{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:#9aa3c0}
.note{border:1px solid #2a3355;border-radius:8px;padding:.75rem 1rem;color:#c9d0e8;background:#121832}
`;

/** A self-contained HTML report (no scripts, no external requests). Every value from the run is escaped. */
export function renderReportHtml(report: RunReport): string {
  const { summary } = report;
  const tier = tiers[report.tier];
  const minutes = Math.max(1, Math.round(summary.durationMs / 60000));
  const bySeverity = SEVERITIES.map(
    (s) => `<li><b>${summary.findings.bySeverity[s] ?? 0}</b>${s}</li>`,
  ).join("");

  const findings =
    report.findings.length === 0
      ? '<p class="muted">No findings were raised by the checks that ran.</p>'
      : report.findings
          .map(
            (f) => `<article class="finding" data-sev="${e(f.severity)}">
<h3>${e(f.id)} · ${e(f.title)}</h3>
<p class="badge">${e(f.severity)} · ${f.verified ? "verified" : "not yet cross-checked"} · ${e(f.agent)}</p>
<p><strong>Affected:</strong> <code>${e(f.component)}</code></p>
<p>${e(f.description)}</p>
<p><strong>Remediation:</strong> ${e(f.remediation)}</p>
${f.mapping ? `<p class="muted">${e(f.mapping)}</p>` : ""}
</article>`,
          )
          .join("\n");

  const list = (items: string[]) => (items.length ? `<ul>${items.join("")}</ul>` : "");

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
<h1>Security assessment: ${e(report.target)}</h1>
<p class="muted">${e(tier.name)} scan · ${e(report.runId)} · generated ${e(report.generatedAt)} · status ${e(report.status)}</p>

<h2>1. Executive summary</h2>
<ul class="sev">${bySeverity}</ul>
<p>${summary.findings.total} findings from ${summary.checks} checks in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}. Coverage of the planned work: ${Math.round(summary.coverage * 100)}%. ${summary.gaps} scope ${summary.gaps === 1 ? "limitation" : "limitations"} are listed below.</p>

<h2>2. Positive findings</h2>
${
  report.passed.length === 0
    ? '<p class="muted">No check completed without a finding.</p>'
    : list(
        report.passed.map(
          (p) => `<li>${e(p.label)} <span class="muted">(${e(p.agent)})</span></li>`,
        ),
      )
}

<h2>3. Scope and methodology</h2>
<p>Target <code>${e(report.target)}</code>, scan depth <strong>${e(tier.name)}</strong>: ${e(tier.description)} All requests went through a scope guard that only allows the declared hosts, refuses private and metadata addresses, and was read-only for this run.</p>

<h2>4. Technical findings</h2>
${findings}

<h2>5. Informational</h2>
${
  report.notes.length === 0
    ? '<p class="muted">Nothing to add.</p>'
    : list(report.notes.map((n) => `<li><strong>${e(n.label)}.</strong> ${e(n.note)}</li>`))
}

<h2>6. Scope limitations and checks not run</h2>
${
  report.gaps.length === 0 && report.notRun.length === 0
    ? '<p class="muted">None.</p>'
    : list([
        ...report.gaps.map((g) => `<li>${e(g.reason)}</li>`),
        ...report.notRun.map(
          (n) => `<li><strong>${e(n.name)}</strong> did not finish: ${e(n.reason)}</li>`,
        ),
      ])
}

<h2>7. Disclaimer</h2>
<p class="note">${e(report.disclaimer)}</p>
</main>
</body>
</html>
`;
}
