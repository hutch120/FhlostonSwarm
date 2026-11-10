import { TIERS, tiers, type TierId } from "@swarm/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, messageFor } from "../api/client.js";
import { formatClock, formatDateTime } from "../format.js";

/** Credits per depth, and what to do when a depth has none. */
export function CreditsLine({ credits }: { credits: Record<TierId, number> }) {
  return (
    <p data-testid="credits">
      {TIERS.map((t, i) => (
        <span key={t.id}>
          {i > 0 && " · "}
          <strong>{credits[t.id]}</strong> {t.name}
        </span>
      ))}
    </p>
  );
}

export function Dashboard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const runs = useQuery({
    queryKey: ["runs"],
    queryFn: () => api.listRuns(),
    // Follow a run that is going: its counts and status change while the page is open.
    refetchInterval: (query) =>
      query.state.data?.some((r) => r.summary.status === "running") ? 5000 : false,
  });
  const account = useQuery({ queryKey: ["account"], queryFn: () => api.getAccount() });
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remove = async (runId: string) => {
    setError(null);
    try {
      await api.deleteRun(runId);
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
    } catch (err) {
      setError(messageFor(err, "Could not delete the run."));
    }
    setConfirming(null);
  };

  const runAgain = async (scanId: string) => {
    setError(null);
    try {
      const { runId } = await api.runScan(scanId);
      await queryClient.invalidateQueries();
      navigate(`/runs/${runId}`);
    } catch (err) {
      setError(messageFor(err, "Could not start the run."));
    }
  };

  const rows = runs.data ?? [];

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
          Your credits
        </h2>
        {account.data ? (
          <>
            <CreditsLine credits={account.data.credits} />
            <p className="muted small">
              Every scan, one-off or scheduled, uses one credit of its depth.{" "}
              {account.data.unmetered
                ? "As staff you can start runs without a credit."
                : "During the private beta credits are granted by our team; purchasing arrives later."}
            </p>
          </>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </section>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

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
                {rows.map(({ summary: s, target, scanId }) => (
                  <tr key={s.runId} data-testid="run-row">
                    <th scope="row">{target}</th>
                    <td>{tiers[s.tier].name}</td>
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
                      {(s.status === "complete" ||
                        s.status === "stopped" ||
                        s.status === "failed") && (
                        <Link to={`/runs/${s.runId}/report`}>Report</Link>
                      )}
                      {scanId && (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => runAgain(scanId)}
                          aria-label={`Run again for ${target}`}
                        >
                          Run again
                        </button>
                      )}
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
        <p className="muted small">
          Deleting a run permanently removes its saved logins, report and evidence.
        </p>
      </section>
    </>
  );
}
