import { tiers } from "@swarm/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { api, messageFor } from "../../api/client.js";
import { formatDateTime } from "../../format.js";
import { SOURCE_LABELS, formatDuration, percent, usd } from "./format.js";

/** One run for staff: what it cost and why, against the caps, with its agents, gaps and event log. */
export function RunDetail() {
  const { runId = "" } = useParams();
  const queryClient = useQueryClient();
  const run = useQuery({
    queryKey: ["staff-run", runId],
    queryFn: () => api.staff.run(runId),
    refetchInterval: (query) =>
      query.state.data?.detail?.status === "running" ||
      query.state.data?.detail?.status === "queued"
        ? 5000
        : false,
  });
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [confirming, setConfirming] = useState(false);

  const act = async (action: () => Promise<void>, done: string, failed: string) => {
    setMessage(null);
    try {
      await action();
      setMessage({ text: done, error: false });
      await queryClient.invalidateQueries({ queryKey: ["staff-run", runId] });
      await queryClient.invalidateQueries({ queryKey: ["staff-runs"] });
    } catch (err) {
      setMessage({ text: messageFor(err, failed), error: true });
    }
    setConfirming(false);
  };

  if (run.isPending) return <p className="muted">Loading…</p>;
  if (run.isError || !run.data) {
    return (
      <p className="error" role="alert">
        That run does not exist. <Link to="/staff">Back to the runs</Link>
      </p>
    );
  }
  const { detail, row } = run.data;

  if (!detail) {
    return (
      <section className="card" aria-labelledby="gone-title" data-testid="staff-run-deleted">
        <h2 id="gone-title" className="card-title">
          Run {runId}
        </h2>
        <p>
          This run, or its account, was deleted. Only the anonymised cost record remains
          {row ? `: ${tiers[row.tier].name}, ${row.status}, ${usd(row.costUsd)}.` : "."}
        </p>
        <Link to="/staff">Back to the runs</Link>
      </section>
    );
  }

  const going = detail.status === "running" || detail.status === "queued";
  const finished = detail.status === "complete" || detail.status === "stopped";
  return (
    <>
      <div className="page-head">
        <h2>
          {tiers[detail.tier].name} run of {detail.target}
        </h2>
        <Link to="/staff">All runs</Link>
      </div>

      <section className="card" aria-labelledby="overview-title">
        <h3 id="overview-title" className="card-title">
          Overview
        </h3>
        <dl className="kv" data-testid="staff-run-overview">
          <dt>Status</dt>
          <dd>
            <span className="badge badge-status" data-status={detail.status}>
              {detail.status}
            </span>
            {detail.reason && <span className="muted"> {detail.reason}</span>}
          </dd>
          <dt>Run</dt>
          <dd>
            <code>{detail.runId}</code>
            {detail.test && <span className="badge"> test</span>}
          </dd>
          <dt>Account</dt>
          <dd>
            <code>{detail.accountHash.slice(0, 12)}…</code>
          </dd>
          <dt>Trigger</dt>
          <dd>{detail.trigger}</dd>
          <dt>Paid by</dt>
          <dd>{SOURCE_LABELS[detail.entitlement]}</dd>
          <dt>Started (UTC)</dt>
          <dd>{formatDateTime(detail.startedAt)}</dd>
          <dt>Duration</dt>
          <dd>{formatDuration(detail.durationSeconds)}</dd>
          <dt>Coverage</dt>
          <dd>{percent(detail.summary.coverage, 0)}</dd>
          <dt>Checks · requests</dt>
          <dd>
            {detail.summary.checks} · {detail.summary.requests}
          </dd>
          <dt>Findings</dt>
          <dd>
            {detail.summary.findings.total} ({detail.summary.findings.verified} verified)
          </dd>
          <dt>Instructions · learned layer</dt>
          <dd>
            {detail.instructionsVersion ?? "n/a"} · {detail.dynamicVersion ?? "none"}
          </dd>
        </dl>
        <div className="actions-row">
          {going && (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() =>
                act(() => api.staff.stopRun(runId), "Stop requested.", "Could not stop the run.")
              }
            >
              Stop run
            </button>
          )}
          {finished && (
            <button
              type="button"
              className="btn"
              onClick={() =>
                act(
                  () => api.staff.resendRunEmail(runId),
                  "The report email was sent again.",
                  "Could not send the email.",
                )
              }
            >
              Resend report email
            </button>
          )}
          {confirming ? (
            <>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() =>
                  act(
                    async () => {
                      await api.staff.deleteRun(runId);
                    },
                    "The run was deleted. Only its anonymised cost record remains.",
                    "Could not delete the run.",
                  )
                }
              >
                Confirm delete
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={() => setConfirming(true)}>
              Delete run
            </button>
          )}
        </div>
        {message && (
          <p className={message.error ? "error" : "hint"} role={message.error ? "alert" : "status"}>
            {message.text}
          </p>
        )}
      </section>

      <section className="card" aria-labelledby="cost-title">
        <h3 id="cost-title" className="card-title">
          Cost
        </h3>
        {detail.cost ? (
          <div className="table-wrap">
            <table data-testid="staff-run-cost">
              <thead>
                <tr>
                  <th scope="col">Component</th>
                  <th scope="col">Usage</th>
                  <th scope="col">Estimated</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Model ({detail.cost.bedrock.modelId ?? "not recorded"})</th>
                  <td>
                    {detail.cost.bedrock.calls} calls,{" "}
                    {detail.cost.bedrock.inputTokens.toLocaleString()} in /{" "}
                    {detail.cost.bedrock.outputTokens.toLocaleString()} out tokens
                  </td>
                  <td>{usd(detail.cost.bedrock.usd)}</td>
                </tr>
                <tr>
                  <th scope="row">Compute</th>
                  <td>{formatDuration(detail.cost.fargate.taskSeconds)} of task time</td>
                  <td>{usd(detail.cost.fargate.usd)}</td>
                </tr>
                <tr>
                  <th scope="row">Data out</th>
                  <td>{(detail.cost.egress.bytesOut / 1024 ** 2).toFixed(1)} MiB</td>
                  <td>{usd(detail.cost.egress.usd)}</td>
                </tr>
                <tr>
                  <th scope="row">Orchestration</th>
                  <td>state transitions</td>
                  <td>{usd(detail.cost.orchestration.usd)}</td>
                </tr>
                {detail.cost.learner && (
                  <tr>
                    <th scope="row">Learning pass ({detail.cost.learner.modelId})</th>
                    <td>
                      {detail.cost.learner.calls} calls, {detail.cost.learner.seconds}s
                    </td>
                    <td>{usd(detail.cost.learner.usd)}</td>
                  </tr>
                )}
                <tr>
                  <th scope="row">Total</th>
                  <td>
                    Prices {detail.cost.pricingVersion}
                    {detail.cost.pricingVerified ? "" : " (not yet checked against AWS)"}
                  </td>
                  <td>
                    <strong>{usd(detail.cost.totalUsd)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">The cost is recorded when the run closes.</p>
        )}
        <p className="muted small">
          The model is only called by the explorer and the planner, which share one meter, so model
          cost is for the run as a whole rather than per agent. All agents run in one task.
        </p>
      </section>

      <section className="card" aria-labelledby="budget-title">
        <h3 id="budget-title" className="card-title">
          Used against the depth's caps
        </h3>
        <div className="table-wrap">
          <table data-testid="staff-run-budgets">
            <thead>
              <tr>
                <th scope="col">Budget</th>
                <th scope="col">Used</th>
                <th scope="col">Cap</th>
                <th scope="col">Share</th>
              </tr>
            </thead>
            <tbody>
              {detail.budgets.map((b) => (
                <tr key={b.name}>
                  <th scope="row">{b.name}</th>
                  <td>
                    {b.unit === "USD" ? usd(b.used) : b.used.toLocaleString()}{" "}
                    {b.unit === "USD" ? "" : b.unit}
                  </td>
                  <td>
                    {b.cap === null
                      ? "none"
                      : b.unit === "USD"
                        ? usd(b.cap)
                        : b.cap.toLocaleString()}
                  </td>
                  <td>{b.cap ? percent(b.used / b.cap, 0) : "n/a"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" aria-labelledby="agents-title">
        <h3 id="agents-title" className="card-title">
          Agents
        </h3>
        {detail.agents.length === 0 ? (
          <p className="muted">No agent has reported yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">Checks</th>
                  <th scope="col">Requests</th>
                  <th scope="col">Findings</th>
                  <th scope="col">Could not test</th>
                  <th scope="col">Finished</th>
                </tr>
              </thead>
              <tbody>
                {detail.agents.map((a) => (
                  <tr key={a.agent}>
                    <th scope="row">{a.name}</th>
                    <td>{a.steps}</td>
                    <td>{a.requests}</td>
                    <td>{a.findings}</td>
                    <td>{a.gaps}</td>
                    <td>{a.done ? "yes" : "no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {detail.gaps.length > 0 && (
          <>
            <h4>Gaps</h4>
            <ul data-testid="staff-run-gaps">
              {detail.gaps.map((g, i) => (
                <li key={i}>
                  {g.agent ? `${g.agent}: ` : ""}
                  {g.reason}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="card" aria-labelledby="events-title">
        <h3 id="events-title" className="card-title">
          Event log ({detail.events.length} of {detail.eventCount})
        </h3>
        <ol className="log" data-testid="staff-run-events">
          {detail.events.map((e) => (
            <li key={e.seq} className="log-line">
              <span className="muted">{e.seq}</span>{" "}
              <span className="log-who">{e.agent ?? "swarm"}</span>{" "}
              <span className="log-text">
                {e.type}: {e.text}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
