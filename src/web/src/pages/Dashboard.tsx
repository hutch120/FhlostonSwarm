import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api/client.js";
import { capitalise, formatClock, formatDateTime } from "../format.js";

export function Dashboard() {
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api.listRuns() });
  const account = useQuery({ queryKey: ["account"], queryFn: () => api.getAccount() });
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<string | null>(null);

  const remove = async (runId: string) => {
    await api.deleteRun(runId);
    setRemoved((prev) => new Set(prev).add(runId));
    setConfirming(null);
  };

  const rows = (runs.data ?? []).filter((r) => !removed.has(r.summary.runId));

  return (
    <>
      <div className="page-head">
        <h1>Dashboard</h1>
        <Link to="/new" className="btn btn-primary">
          New assessment
        </Link>
      </div>

      <section className="card" aria-labelledby="credits-title">
        <h2 id="credits-title" className="card-title">
          Your reports
        </h2>
        {account.data ? (
          <p data-testid="credits">
            <strong>{account.data.freeLiteRemaining}</strong> free Lite report remaining ·{" "}
            <strong>{account.data.paidCredits}</strong> paid credits
          </p>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </section>

      <section className="card" aria-labelledby="runs-title">
        <h2 id="runs-title" className="card-title">
          Past runs
        </h2>
        {runs.isPending ? (
          <p className="muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="muted">No runs yet. Start a new assessment.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Target</th>
                  <th scope="col">Tier</th>
                  <th scope="col">Status</th>
                  <th scope="col">Started</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Findings</th>
                  <th scope="col">Coverage</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ summary: s, target }) => (
                  <tr key={s.runId} data-testid="run-row">
                    <th scope="row">{target}</th>
                    <td>{capitalise(s.tier)}</td>
                    <td>
                      <span className="badge badge-status" data-status={s.status}>
                        {s.status}
                      </span>
                    </td>
                    <td>{formatDateTime(s.startedAt)}</td>
                    <td>{formatClock(s.durationMs)}</td>
                    <td>
                      {s.findings.total}
                      {s.findings.bySeverity.critical + s.findings.bySeverity.high > 0 && (
                        <span className="muted">
                          {" "}
                          ({s.findings.bySeverity.critical + s.findings.bySeverity.high} high or
                          above)
                        </span>
                      )}
                    </td>
                    <td>{Math.round(s.coverage * 100)}%</td>
                    <td className="actions">
                      <Link to={`/runs/${s.runId}`}>Watch</Link>
                      <Link to={`/runs/${s.runId}/report`}>Report</Link>
                      {confirming === s.runId ? (
                        <>
                          <button
                            type="button"
                            className="btn btn-danger"
                            onClick={() => remove(s.runId)}
                          >
                            Confirm delete
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() => setConfirming(null)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => setConfirming(s.runId)}
                          aria-label={`Delete run for ${target}`}
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">Sample data. Deleting a run removes its report and evidence.</p>
      </section>
    </>
  );
}
