import {
  AGENTS,
  DEMO_RUN_ID,
  DEMO_TARGET,
  SEVERITIES,
  applyEvents,
  buildReport,
  createRunState,
  replayEvents,
  summarise,
  tierRoster,
  type RunReport,
} from "@swarm/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { api, messageFor } from "../api/client.js";
import { capitalise, formatClock } from "../format.js";
import { SeverityBadge, VerifiedBadge } from "../panels/FindingsPanel.js";

/** The report of the scripted demo run, built the same way a real run's is. */
function demoReport(): RunReport {
  const { areas } = tierRoster("siege");
  const state = applyEvents(
    createRunState({ runId: DEMO_RUN_ID, tier: "siege", areas, agents: AGENTS }),
    replayEvents,
  );
  return buildReport({
    state,
    events: replayEvents,
    summary: summarise(state),
    target: DEMO_TARGET,
    generatedAt: replayEvents.at(-1)!.ts,
  });
}

export function Report() {
  const { runId = "" } = useParams();
  if (runId === DEMO_RUN_ID) return <ReportView report={demoReport()} demo />;
  return <RealReport runId={runId} />;
}

function RealReport({ runId }: { runId: string }) {
  const report = useQuery({
    queryKey: ["report", runId],
    queryFn: () => api.getReport(runId),
    retry: false,
  });
  if (report.isPending) return <p className="muted">Loading…</p>;
  if (report.isError) {
    return (
      <section className="card narrow">
        <h1>Report</h1>
        <p>
          {messageFor(report.error, "The report could not be loaded.")}{" "}
          <Link to={`/runs/${runId}`}>Back to the run</Link>
        </p>
      </section>
    );
  }
  return <ReportView report={report.data} />;
}

function ReportView({ report, demo = false }: { report: RunReport; demo?: boolean }) {
  const { summary } = report;
  const [error, setError] = useState<string | null>(null);

  const downloadHtml = async () => {
    setError(null);
    try {
      const link = await api.getReportLink(report.runId);
      // The link carries Content-Disposition: attachment, so the browser downloads it from S3.
      const anchor = document.createElement("a");
      anchor.href = link.url;
      anchor.rel = "noopener";
      anchor.click();
    } catch (err) {
      setError(messageFor(err, "Could not prepare the download."));
    }
  };
  const downloadJson = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `swarm-report-${report.runId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Report</h1>
          <p className="muted">
            <code>{report.target}</code> · {capitalise(report.tier)} scan ·{" "}
            {formatClock(summary.durationMs)} · {Math.round(summary.coverage * 100)}% coverage ·{" "}
            <span data-testid="report-status">{report.status}</span>
          </p>
        </div>
        <div className="actions-row">
          <button type="button" className="btn" disabled={demo} onClick={() => void downloadHtml()}>
            Download HTML
          </button>
          <button type="button" className="btn" onClick={downloadJson}>
            Download JSON
          </button>
          <button type="button" className="btn" disabled title="PDF arrives with the full report">
            Download PDF
          </button>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {demo && (
        <p className="notice" role="note">
          This is the report of the simulated demo run.
        </p>
      )}

      <section className="card" aria-labelledby="exec-title">
        <h2 id="exec-title" className="card-title">
          Executive summary
        </h2>
        <ul className="sev-row">
          {SEVERITIES.map((s) => (
            <li key={s} data-severity={s}>
              <span className="sev-count">{summary.findings.bySeverity[s]}</span>
              <span>{s}</span>
            </li>
          ))}
        </ul>
        <p data-testid="report-summary">
          {summary.findings.total} findings ({summary.findings.verified} verified), {summary.checks}{" "}
          checks, {summary.gaps} scope gaps.
        </p>
      </section>

      <section className="card" aria-labelledby="understood-title">
        <h2 id="understood-title" className="card-title">
          What we understood about the application
        </h2>
        {report.profile ? (
          <div data-testid="report-profile">
            <p>{report.profile.purpose}</p>
            <p className="muted small">
              Described from {report.profile.coverage.pagesVisited} pages
              {report.profile.coverage.signedIn
                ? `, including the signed-in side (${report.profile.coverage.loginsUsed} login${report.profile.coverage.loginsUsed === 1 ? "" : "s"})`
                : ", signed out"}
              . This is the scan&apos;s reading of what it saw, not a statement from the
              application&apos;s owner.
            </p>
            {report.profile.areas.length > 0 && (
              <>
                <h3>Areas and features</h3>
                <ul>
                  {report.profile.areas.map((a, i) => (
                    <li key={i}>
                      <strong>{a.name}</strong>
                      {a.path && (
                        <>
                          {" "}
                          <code>{a.path}</code>
                        </>
                      )}
                      {a.requiresLogin && <span className="muted"> (signed in)</span>}:{" "}
                      {a.description}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {report.profile.roles.length > 0 && (
              <>
                <h3>Roles</h3>
                <ul>
                  {report.profile.roles.map((r, i) => (
                    <li key={i}>
                      <strong>{r.name}</strong>: {r.description}
                      {r.access.length > 0 && <> Reaches: {r.access.join(", ")}.</>}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {report.profile.flows.length > 0 && (
              <>
                <h3>Main flows</h3>
                <ul>
                  {report.profile.flows.map((f, i) => (
                    <li key={i}>
                      <strong>{f.name}</strong>: {f.description}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {report.profile.technologies.length > 0 && (
              <>
                <h3>Technologies seen</h3>
                <p>{report.profile.technologies.join(", ")}</p>
              </>
            )}
          </div>
        ) : (
          <p className="muted">The scan could not build a description of the application.</p>
        )}
      </section>

      <section className="card" aria-labelledby="findings-title">
        <h2 id="findings-title" className="card-title">
          Technical findings
        </h2>
        {report.findings.length === 0 ? (
          <p className="muted">No findings were raised by the checks that ran.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">ID</th>
                  <th scope="col">Severity</th>
                  <th scope="col">Title</th>
                  <th scope="col">Component</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {report.findings.map((f) => (
                  <tr key={f.id} data-testid="report-finding">
                    <th scope="row">{f.id}</th>
                    <td>
                      <SeverityBadge severity={f.severity} />
                    </td>
                    <td>
                      {f.title}
                      <p className="muted small">{f.description}</p>
                      <p className="small">
                        <strong>Fix:</strong> {f.remediation}
                      </p>
                    </td>
                    <td>
                      <code>{f.component}</code>
                    </td>
                    <td>
                      <VerifiedBadge verified={f.verified} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="passed-title">
        <h2 id="passed-title" className="card-title">
          Positive findings
        </h2>
        {report.passed.length === 0 ? (
          <p className="muted">No check completed without a finding.</p>
        ) : (
          <ul>
            {report.passed.map((p) => (
              <li key={`${p.agent}-${p.stepId}`}>{p.label}</li>
            ))}
          </ul>
        )}
      </section>

      {report.notes.length > 0 && (
        <section className="card" aria-labelledby="notes-title">
          <h2 id="notes-title" className="card-title">
            Informational
          </h2>
          <ul>
            {report.notes.map((n) => (
              <li key={`${n.agent}-${n.label}`}>
                <strong>{n.label}.</strong> {n.note}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card" aria-labelledby="gaps-title">
        <h2 id="gaps-title" className="card-title">
          Scope limitations
        </h2>
        {report.gaps.length === 0 && report.notRun.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <ul data-testid="report-gaps">
            {report.gaps.map((g, i) => (
              <li key={i}>{g.reason}</li>
            ))}
            {report.notRun.map((n) => (
              <li key={n.agent}>
                <strong>{n.name}</strong> did not finish: {n.reason}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby="notincluded-title">
        <h2 id="notincluded-title" className="card-title">
          Not included at this depth
        </h2>
        {report.notIncluded.length === 0 ? (
          <p className="muted">This depth runs every agent.</p>
        ) : (
          <>
            <p className="muted">A deeper scan adds these checks.</p>
            <ul data-testid="report-not-included">
              {report.notIncluded.map((n) => (
                <li key={n.agent}>
                  <strong>{n.name}</strong>: {n.covers}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <p className="notice" role="note">
        {report.disclaimer}
      </p>

      <p>
        <Link to={demo ? "/demo" : `/runs/${report.runId}`}>
          {demo ? "Back to the live demo" : "Back to the run"}
        </Link>
      </p>
    </>
  );
}
