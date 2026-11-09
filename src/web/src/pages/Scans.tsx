import { FREQUENCY_LABELS, isRecurring, tiers, type ScanStatus } from "@swarm/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, messageFor } from "../api/client.js";
import { formatDateTime } from "../format.js";

/**
 * Saved scans. Each one remembers the target, logins, depth, schedule and notification address, so
 * running it again never means configuring it from scratch. Saved targets are listed below, where
 * their stored logins can be removed.
 */
export function Scans() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const scans = useQuery({ queryKey: ["scans"], queryFn: () => api.listScans() });
  const targets = useQuery({ queryKey: ["targets"], queryFn: () => api.listTargets() });
  const [confirming, setConfirming] = useState<string | null>(null);
  const [confirmingTarget, setConfirmingTarget] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = scans.data ?? [];

  // Runs the action, reports any failure, and reloads everything the change can affect.
  const act = async (action: () => Promise<unknown>, fallback: string, then?: () => void) => {
    setError(null);
    setNotice(null);
    try {
      await action();
      await queryClient.invalidateQueries();
      then?.();
    } catch (err) {
      setError(messageFor(err, fallback));
    }
  };

  const runAgain = (scanId: string) =>
    act(async () => {
      const { runId } = await api.runScan(scanId);
      navigate(`/runs/${runId}`);
    }, "Could not start the run.");
  const setStatus = (scanId: string, status: ScanStatus) =>
    act(() => api.setScanStatus(scanId, status), "Could not change the scan.");
  const remove = (scanId: string) =>
    act(
      () => api.deleteScan(scanId),
      "Could not delete the scan.",
      () => setConfirming(null),
    );
  const resend = (scanId: string) =>
    act(
      () => api.resendNotifyConfirmation(scanId),
      "Could not send the link.",
      () => setNotice("We sent a new confirmation link."),
    );
  const removeTarget = (targetId: string) =>
    act(
      () => api.deleteTarget(targetId),
      "Could not delete the target.",
      () => setConfirmingTarget(null),
    );

  return (
    <>
      <div className="page-head">
        <h1>Scans</h1>
        <Link to="/new" className="btn btn-primary">
          New assessment
        </Link>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      <section className="card" aria-labelledby="scans-title">
        <h2 id="scans-title" className="card-title">
          Saved scans
        </h2>
        <p className="muted">
          A scan remembers the application, logins, depth, schedule and who to email. Run it again
          at any time. Each run uses one credit. Repeating schedules are saved but do not run by
          themselves yet.
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
                              <>
                                <span className="badge badge-unverified"> Unconfirmed</span>
                                <button
                                  type="button"
                                  className="btn btn-ghost"
                                  onClick={() => resend(s.id)}
                                  aria-label={`Resend confirmation link for ${s.name}`}
                                >
                                  Resend link
                                </button>
                              </>
                            )}
                          </>
                        )}
                      </td>
                      <td>
                        {recurring ? (
                          <span className="badge badge-status" data-status={s.status}>
                            {s.status}
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
                        ) : s.lastRun ? (
                          <Link to={`/runs/${s.lastRun.runId}`}>{s.lastRun.status}</Link>
                        ) : (
                          <span className="muted">Not yet</span>
                        )}
                      </td>
                      <td>
                        {recurring && s.status === "active" && s.nextRunAt ? (
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
                        <Link to={`/scans/${s.id}/edit`} aria-label={`Edit ${s.name}`}>
                          Edit
                        </Link>
                        {recurring && (
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() =>
                              setStatus(s.id, s.status === "active" ? "paused" : "active")
                            }
                            aria-label={`${s.status === "active" ? "Pause" : "Resume"} ${s.name}`}
                          >
                            {s.status === "active" ? "Pause" : "Resume"}
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
          A notification address other than your account email must be confirmed before it receives
          anything. Deleting a scan stops its schedule; past runs and reports stay until you delete
          them.
        </p>
      </section>

      <section className="card" aria-labelledby="targets-title">
        <h2 id="targets-title" className="card-title">
          Saved targets
        </h2>
        <p className="muted">
          A target holds the application URLs and the test logins. Several scans can share one, so
          changing a password once fixes every scan on it. Saved passwords are never shown again.
        </p>
        {targets.isPending ? (
          <p className="muted">Loading…</p>
        ) : (targets.data ?? []).length === 0 ? (
          <p className="muted">No saved targets.</p>
        ) : (
          <ul className="plain" data-testid="targets">
            {(targets.data ?? []).map((t) => (
              <li key={t.id} data-testid="target-row">
                <strong>{t.hosts[0]}</strong>
                <span className="muted small">
                  {" "}
                  · {Object.keys(t.logins).length} saved login
                  {Object.keys(t.logins).length === 1 ? "" : "s"} · {t.scans.length} scan
                  {t.scans.length === 1 ? "" : "s"}
                </span>{" "}
                {confirmingTarget === t.id ? (
                  <span role="group" aria-label={`Confirm deleting ${t.hosts[0] ?? "target"}`}>
                    <span className="muted small">
                      This also deletes{" "}
                      {t.scans.length === 0 ? "no scans" : t.scans.map((s) => s.name).join(", ")}.
                      Past runs stay.
                    </span>{" "}
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={() => removeTarget(t.id)}
                    >
                      Confirm delete target
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => setConfirmingTarget(null)}
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setConfirmingTarget(t.id)}
                    aria-label={`Delete target ${t.hosts[0] ?? ""}`}
                  >
                    Delete target
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
