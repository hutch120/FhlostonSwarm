import { tiers, type TierId } from "@swarm/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, messageFor } from "../api/client.js";
import { formatDateTime } from "../format.js";
import { useLiveRun } from "../live/useLiveRun.js";
import { useRunStore } from "../state/run.js";
import { RunBoard } from "./LiveRun.js";

/**
 * A real run. Until it starts it waits here; once it runs, the page follows its event stream (the live
 * channel, falling back to polling) and shows the same board as the demo. It ends with a link to the report.
 */
export function RunView({ runId }: { runId: string }) {
  const queryClient = useQueryClient();
  const run = useQuery({ queryKey: ["run", runId], queryFn: () => api.getRun(runId) });
  const start = useMutation({
    mutationFn: () => api.startRun(runId),
    onSettled: () => queryClient.invalidateQueries(),
  });

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
  const { summary, target, reason } = run.data;

  if (summary.status === "queued") {
    return (
      <>
        <div className="page-head">
          <div>
            <h1>Run queued</h1>
            <p className="muted">
              Target <code>{target}</code> · {tiers[summary.tier].name} scan · {runId}
            </p>
          </div>
          <span
            className="badge badge-status"
            data-status={summary.status}
            data-testid="run-status"
          >
            {summary.status}
          </span>
        </div>
        <section className="card">
          <p data-testid="queued-note">
            Your scan is saved and its credit is spent. Created {formatDateTime(summary.startedAt)}.
            The agents start when you start the run.
          </p>
          {start.isError && (
            <p className="error" role="alert">
              {messageFor(start.error, "Could not start the run.")}
            </p>
          )}
          <p className="actions-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={start.isPending}
              onClick={() => start.mutate()}
            >
              Start run
            </button>
            <Link to="/dashboard">Back to the dashboard</Link>
          </p>
        </section>
      </>
    );
  }

  return (
    <ActiveRun
      key={runId}
      runId={runId}
      tier={summary.tier}
      target={target}
      status={summary.status}
      reason={reason}
    />
  );
}

function ActiveRun({
  runId,
  tier,
  target,
  status: initialStatus,
  reason,
}: {
  runId: string;
  tier: TierId;
  target: string;
  status: "running" | "complete" | "stopped" | "failed";
  reason?: string;
}) {
  const queryClient = useQueryClient();
  const live = useLiveRun(runId, tier);
  const state = useRunStore((s) => s.state);
  const stop = useMutation({
    mutationFn: () => api.stopRun(runId),
    onSettled: () => queryClient.invalidateQueries(),
  });

  const status = state.status === "idle" ? initialStatus : state.status;
  const ended = status === "complete" || status === "stopped" || status === "failed";
  const headline =
    status === "complete"
      ? "Report assembled."
      : status === "stopped"
        ? "Run stopped."
        : "Run ended early.";
  const transport =
    live.ended || ended
      ? null
      : live.transport === "live"
        ? "Live"
        : live.transport === "polling"
          ? "Updating every few seconds"
          : "Connecting…";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Live swarm view</h1>
          <p className="muted">
            Target <code>{target}</code> · {tiers[tier].name} scan · {runId}
          </p>
        </div>
        <div className="actions-row">
          {transport && (
            <span className="muted small" data-testid="transport">
              {transport}
            </span>
          )}
          {status === "running" && (
            <button
              type="button"
              className="btn btn-danger"
              disabled={stop.isPending}
              onClick={() => stop.mutate()}
            >
              Stop run
            </button>
          )}
          <span className="badge badge-status" data-status={status} data-testid="run-status">
            {status}
          </span>
        </div>
      </div>

      {stop.isError && (
        <p className="error" role="alert">
          {messageFor(stop.error, "Could not stop the run.")}
        </p>
      )}

      {ended && (
        <div className="banner" role="status" data-testid="report-banner">
          <strong>{headline}</strong> {state.findings.length} findings from {state.checks} checks.{" "}
          {reason && <>{reason} </>}
          <Link to={`/runs/${runId}/report`}>Open the report</Link>
        </div>
      )}

      <RunBoard target={target} tier={tier} />
    </>
  );
}
