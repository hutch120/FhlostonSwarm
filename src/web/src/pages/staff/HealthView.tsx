import { TIERS } from "@swarm/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../../api/client.js";
import { formatDateTime } from "../../format.js";
import { percent, usd } from "./format.js";

/** SES complaint and bounce rates above these put sending at risk (AWS review thresholds). */
const BOUNCE_WARN = 0.05;
const COMPLAINT_WARN = 0.001;

/** Is the service healthy: spend against the alarm, stuck runs, mail reputation, Bedrock throttling. */
export function HealthView() {
  const health = useQuery({
    queryKey: ["staff-health"],
    queryFn: () => api.staff.health(),
    refetchInterval: 30_000,
  });
  if (health.isPending) return <p className="muted">Loading…</p>;
  if (health.isError) {
    return (
      <p className="error" role="alert">
        Could not load the health view.
      </p>
    );
  }
  const h = health.data;
  const spendOver = h.spendToday.alarmUsd !== null && h.spendToday.usd >= h.spendToday.alarmUsd;

  return (
    <>
      {h.killSwitchOn && (
        <p className="notice" role="alert">
          The kill switch is on: no new run can start. <Link to="/staff/controls">Controls</Link>
        </p>
      )}
      <section className="card" aria-labelledby="spend-title">
        <h2 id="spend-title" className="card-title">
          Spend today
        </h2>
        <p data-testid="health-spend">
          <strong>{usd(h.spendToday.usd)}</strong> over {h.spendToday.runs} runs on{" "}
          {h.spendToday.day} (UTC).{" "}
          {h.spendToday.alarmUsd === null
            ? "No alarm is set."
            : spendOver
              ? `Over the alarm of ${usd(h.spendToday.alarmUsd)}${h.spendToday.alarmed ? " (staff were told)" : ""}.`
              : `Under the alarm of ${usd(h.spendToday.alarmUsd)}.`}
        </p>
      </section>

      <section className="card" aria-labelledby="pools-title">
        <h2 id="pools-title" className="card-title">
          Runs in flight
        </h2>
        <div className="table-wrap">
          <table data-testid="health-pools">
            <thead>
              <tr>
                <th scope="col">Depth</th>
                <th scope="col">Running</th>
                <th scope="col">Waiting</th>
                <th scope="col">Allowed at once</th>
              </tr>
            </thead>
            <tbody>
              {TIERS.map((t) => (
                <tr key={t.id}>
                  <th scope="row">{t.name}</th>
                  <td>{h.pools[t.id].active}</td>
                  <td>{h.pools[t.id].waiting}</td>
                  <td>{h.pools[t.id].limit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3>Stuck runs</h3>
        {h.stuckRuns.length === 0 ? (
          <p className="muted" data-testid="health-stuck">
            None. Every run is within its time.
          </p>
        ) : (
          <ul data-testid="health-stuck">
            {h.stuckRuns.map((r) => (
              <li key={r.runId}>
                <Link to={`/staff/runs/${r.runId}`}>{r.runId}</Link>: {r.tier}, {r.status} for{" "}
                {r.ageMinutes} minutes
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby="mail-title">
        <h2 id="mail-title" className="card-title">
          Email (last 24 hours)
        </h2>
        {h.ses ? (
          <>
            <p data-testid="health-ses">
              {h.ses.sends} sent, {h.ses.bounces} bounced ({percent(h.ses.bounceRate, 2)}),{" "}
              {h.ses.complaints} complaints ({percent(h.ses.complaintRate, 3)}).
            </p>
            {(h.ses.bounceRate >= BOUNCE_WARN || h.ses.complaintRate >= COMPLAINT_WARN) && (
              <p className="error" role="alert">
                These rates are at a level SES can pause sending for.
              </p>
            )}
            {h.ses.reputationBounceRate !== null && (
              <p className="muted small">
                SES's own reputation figures: bounce {percent(h.ses.reputationBounceRate, 2)},
                complaint {percent(h.ses.reputationComplaintRate ?? 0, 3)}.
              </p>
            )}
          </>
        ) : (
          <p className="muted" data-testid="health-ses">
            Not available. CloudWatch had no data or could not be read.
          </p>
        )}
        <p className="muted small">
          {h.suppressed} addresses are suppressed after a bounce or complaint.
        </p>
      </section>

      <section className="card" aria-labelledby="bedrock-title">
        <h2 id="bedrock-title" className="card-title">
          Model throttling (last 24 hours)
        </h2>
        {h.bedrock ? (
          <p data-testid="health-bedrock">
            {h.bedrock.throttles} throttled model calls across {h.bedrock.modelIds.length} models.
            Runs retry throttled calls, so a few are normal; many means the request quota is too
            low.
          </p>
        ) : (
          <p className="muted" data-testid="health-bedrock">
            Not available.
          </p>
        )}
      </section>
      <p className="muted small">
        Checked {formatDateTime(h.at)} (UTC), and again every 30 seconds.
      </p>
    </>
  );
}
