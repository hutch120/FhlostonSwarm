import type { RunState } from "@swarm/shared";
import { describeEvent } from "../format.js";

const MAX_LINES = 120;

/** Newest first, capped so a long run does not grow the DOM without bound. */
export function EventLog({ state }: { state: RunState }) {
  const lines = state.log
    .slice(-MAX_LINES)
    .reverse()
    .map((e) => describeEvent(state, e));
  return (
    <section className="panel panel-log" aria-labelledby="log-heading">
      <h2 id="log-heading" className="panel-title">
        Event log
      </h2>
      {lines.length === 0 ? (
        <p className="muted">Waiting for the first event.</p>
      ) : (
        <div role="log" aria-live="off" data-testid="event-log">
          <ol className="log">
            {lines.map((l) => (
              <li key={l.seq} className="log-line" data-tone={l.tone} data-severity={l.severity}>
                <span className="log-who">{l.who}</span>
                <span className="log-text">{l.text}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
