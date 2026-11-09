import { tiers } from "@swarm/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../api/client.js";
import { formatDateTime } from "../format.js";

/**
 * A real run. Execution arrives in a later phase, so for now a run is queued: its settings are
 * snapshotted and its credit is spent, and it waits here.
 */
export function QueuedRun({ runId }: { runId: string }) {
  const run = useQuery({ queryKey: ["run", runId], queryFn: () => api.getRun(runId) });

  if (run.isError) {
    return (
      <section className="card narrow">
        <h1>Run not found</h1>
        <p>
          It may have been deleted. <Link to="/dashboard">Back to the dashboard</Link>
        </p>
      </section>
    );
  }
  if (!run.data) return <p className="muted">Loading…</p>;
  const { summary, target } = run.data;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Run {summary.status}</h1>
          <p className="muted">
            Target <code>{target}</code> · {tiers[summary.tier].name} scan · {runId}
          </p>
        </div>
        <span className="badge badge-status" data-status={summary.status} data-testid="run-status">
          {summary.status}
        </span>
      </div>
      <section className="card">
        <p data-testid="queued-note">
          Your scan is saved and its credit is spent. Started {formatDateTime(summary.startedAt)}.
          The agents do not run yet: live runs and reports arrive in a later phase.
        </p>
        <p>
          <Link to="/dashboard">Back to the dashboard</Link> · <Link to="/scans">Your scans</Link>
        </p>
      </section>
    </>
  );
}
