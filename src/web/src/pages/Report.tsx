import {
  AGENTS,
  AREAS,
  DEMO_TARGET,
  SEVERITIES,
  applyEvents,
  createRunState,
  replayEvents,
  summarise,
} from "@swarm/shared";
import { useMemo } from "react";
import { Link } from "react-router";
import { capitalise, formatClock } from "../format.js";
import { SeverityBadge, VerifiedBadge } from "../panels/FindingsPanel.js";

const SECTIONS = [
  "Executive summary",
  "Positive findings",
  "Scope and methodology",
  "Testing performed",
  "AI / LLM testing",
  "Technical findings",
  "Static code analysis",
  "Informational",
  "Recommended priorities",
] as const;

/** Placeholder: summarises the demo run. The real renderer arrives with the report phase. */
export function Report() {
  const state = useMemo(
    () =>
      applyEvents(
        createRunState({
          runId: replayEvents[0]!.runId,
          tier: "siege",
          areas: AREAS,
          agents: AGENTS,
        }),
        replayEvents,
      ),
    [],
  );
  const summary = summarise(state);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Report</h1>
          <p className="muted">
            <code>{DEMO_TARGET}</code> · {capitalise(summary.tier)} scan ·{" "}
            {formatClock(summary.durationMs)} · {Math.round(summary.coverage * 100)}% coverage
          </p>
        </div>
        <div className="actions-row">
          {["HTML", "PDF", "JSON"].map((kind) => (
            <button key={kind} type="button" className="btn" disabled>
              Download {kind}
            </button>
          ))}
        </div>
      </div>
      <p className="notice" role="note">
        Placeholder. The full report viewer is built later; this page shows the demo run&apos;s
        numbers and the sections the report will contain.
      </p>

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
        <p>
          {summary.findings.total} findings ({summary.findings.verified} verified), {summary.checks}{" "}
          checks, {summary.gaps} scope gaps.
        </p>
      </section>

      <section className="card" aria-labelledby="findings-title">
        <h2 id="findings-title" className="card-title">
          Technical findings
        </h2>
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
              {state.findings.map((f) => (
                <tr key={f.id}>
                  <th scope="row">{f.id}</th>
                  <td>
                    <SeverityBadge severity={f.severity} />
                  </td>
                  <td>{f.title}</td>
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
      </section>

      <section className="card" aria-labelledby="gaps-title">
        <h2 id="gaps-title" className="card-title">
          Scope limitations
        </h2>
        <ul>
          {state.gaps.map((g) => (
            <li key={g.seq}>{g.reason}</li>
          ))}
        </ul>
      </section>

      <section className="card" aria-labelledby="outline-title">
        <h2 id="outline-title" className="card-title">
          Report outline
        </h2>
        <ol className="outline">
          {SECTIONS.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </section>

      <p>
        <Link to="/demo">Back to the live demo</Link>
      </p>
    </>
  );
}
