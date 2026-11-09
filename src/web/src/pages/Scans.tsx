import { FREQUENCY_LABELS, isRecurring, tiers, type ScanStatus } from "@swarm/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api/client.js";
import { formatDateTime } from "../format.js";

/**
 * Saved scans. Each one remembers the target, logins, depth, schedule and notification address, so
 * running it again never means configuring it from scratch.
 */
export function Scans() {
  const navigate = useNavigate();
  const scans = useQuery({ queryKey: ["scans"], queryFn: () => api.listScans() });
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<Record<string, ScanStatus>>({});
  const [confirming, setConfirming] = useState<string | null>(null);

  const rows = (scans.data ?? []).filter((s) => !removed.has(s.id));

  const runAgain = async (scanId: string) => {
    const { runId } = await api.runScan(scanId);
    navigate(`/runs/${runId}`);
  };
  const setStatus = async (scanId: string, status: ScanStatus) => {
    await api.setScanStatus(scanId, status);
    setStatuses((prev) => ({ ...prev, [scanId]: status }));
  };
  const remove = async (scanId: string) => {
    await api.deleteScan(scanId);
    setRemoved((prev) => new Set(prev).add(scanId));
    setConfirming(null);
  };

  return (
    <>
      <div className="page-head">
        <h1>Scans</h1>
        <Link to="/new" className="btn btn-primary">
          New assessment
        </Link>
      </div>

      <section className="card" aria-labelledby="scans-title">
        <h2 id="scans-title" className="card-title">
          Saved scans
        </h2>
        <p className="muted">
          A scan remembers the application, logins, depth, schedule and who to email. Run it again
          at any time, or let it repeat daily, weekly, monthly or yearly. Each run uses one credit.
        </p>
        {scans.isPending ? (
          <p className="muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="muted">No saved scans yet. Start a new assessment.</p>
        ) : (
          <div className="table-wrap">
            <table data-testid="scans-table">
              <thead>
                <tr>
                  <th scope="col">Scan</th>
                  <th scope="col">Depth</th>
                  <th scope="col">Runs</th>
                  <th scope="col">Notifies</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last run</th>
                  <th scope="col">Next run</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const status = statuses[s.id] ?? s.status;
                  const recurring = isRecurring(s.frequency);
                  return (
                    <tr key={s.id} data-testid="scan-row">
                      <th scope="row">
                        {s.name}
                        <span className="muted small block">{s.target}</span>
                      </th>
                      <td>{tiers[s.tier].name}</td>
                      <td>{FREQUENCY_LABELS[s.frequency]}</td>
                      <td>
                        {s.notifyOn === "never" ? (
                          <span className="muted">Nobody</span>
                        ) : (
                          <>
                            {s.notifyEmail}
                            {!s.notifyEmailConfirmed && (
                              <span className="badge badge-unverified"> Unconfirmed</span>
                            )}
                          </>
                        )}
                      </td>
                      <td>
                        {recurring ? (
                          <span className="badge badge-status" data-status={status}>
                            {status}
                          </span>
                        ) : (
                          <span className="muted">-</span>
                        )}
                      </td>
                      <td>
                        {s.lastRun?.finishedAt ? (
                          <Link to={`/runs/${s.lastRun.runId}/report`}>
                            {formatDateTime(s.lastRun.finishedAt)}
                          </Link>
                        ) : (
                          <span className="muted">Not yet</span>
                        )}
                      </td>
                      <td>
                        {recurring && status === "active" && s.nextRunAt ? (
                          formatDateTime(s.nextRunAt)
                        ) : (
                          <span className="muted">-</span>
                        )}
                      </td>
                      <td className="actions">
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => runAgain(s.id)}
                          aria-label={`Run ${s.name} again`}
                        >
                          Run again
                        </button>
                        {recurring && (
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() =>
                              setStatus(s.id, status === "active" ? "paused" : "active")
                            }
                            aria-label={`${status === "active" ? "Pause" : "Resume"} ${s.name}`}
                          >
                            {status === "active" ? "Pause" : "Resume"}
                          </button>
                        )}
                        {confirming === s.id ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-danger"
                              onClick={() => remove(s.id)}
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
                            onClick={() => setConfirming(s.id)}
                            aria-label={`Delete ${s.name}`}
                          >
                            Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">
          Sample data. A notification address other than your account email must be confirmed before
          it receives anything. Deleting a scan stops its schedule; past runs and reports stay until
          you delete them.
        </p>
      </section>
    </>
  );
}
