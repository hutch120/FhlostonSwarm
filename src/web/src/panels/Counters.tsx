import { tiers, type RunState } from "@swarm/shared";
import { formatClock, formatUsd } from "../format.js";

function Meter({
  label,
  value,
  max,
  text,
}: {
  label: string;
  value: number;
  max: number;
  text: string;
}) {
  const ratio = Math.min(1, value / max);
  const percent = Math.round(ratio * 100);
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span className="meter-text">{text}</span>
      </div>
      <div
        className="bar"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.min(value, max)}
        aria-valuetext={text}
      >
        <span
          className="bar-fill"
          data-level={ratio > 0.85 ? "high" : ratio > 0.6 ? "mid" : "low"}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/** Checks counter and the cost/request budget against the tier's caps. */
export function Counters({ state }: { state: RunState }) {
  const tier = tiers[state.tier];
  const elapsed =
    state.startedAt && state.lastEventAt
      ? Date.parse(state.lastEventAt) - Date.parse(state.startedAt)
      : 0;
  return (
    <section className="panel" aria-labelledby="counters-heading">
      <h2 id="counters-heading" className="panel-title">
        Progress
      </h2>
      <dl className="stats">
        <div>
          <dt>Checks completed</dt>
          <dd data-testid="checks-count">{state.checks}</dd>
        </div>
        <div>
          <dt>Requests sent</dt>
          <dd data-testid="requests-count">{state.requests}</dd>
        </div>
        <div>
          <dt>Scope gaps</dt>
          <dd data-testid="gaps-count">{state.gaps.length}</dd>
        </div>
        <div>
          <dt>Elapsed</dt>
          <dd>{formatClock(elapsed)}</dd>
        </div>
      </dl>
      <Meter
        label="Spend budget"
        value={state.spendUsd}
        max={tier.spendCapUsd}
        text={`${formatUsd(state.spendUsd)} of ${formatUsd(tier.spendCapUsd)}`}
      />
      <Meter
        label="Request budget"
        value={state.requests}
        max={tier.requestCap}
        text={`${state.requests} of ${tier.requestCap}`}
      />
    </section>
  );
}
