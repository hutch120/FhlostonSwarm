import { selectAreas, type RunState } from "@swarm/shared";

interface Props {
  state: RunState;
  selected: string | null;
  onSelect: (agentId: string) => void;
}

const STATUS_LABEL = {
  idle: "waiting",
  dispatched: "dispatched",
  working: "working",
  done: "done",
} as const;

/** Per-area progress bars with each area's agents as selectable chips. */
export function AreasPanel({ state, selected, onSelect }: Props) {
  const areas = selectAreas(state);
  return (
    <section className="panel" aria-labelledby="areas-heading">
      <h2 id="areas-heading" className="panel-title">
        Areas
      </h2>
      <ul className="areas">
        {areas.map((area) => {
          const percent = Math.round(area.progress * 100);
          return (
            <li key={area.spec.id} className="area" data-testid="area" data-area={area.spec.id}>
              <div className="area-head">
                <span className="area-dot" data-area={area.spec.id} aria-hidden="true" />
                <span className="area-name">{area.spec.name}</span>
                <span className="area-percent">{percent}%</span>
              </div>
              <div
                className="bar"
                role="progressbar"
                aria-label={`${area.spec.name} progress`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <span
                  className="bar-fill"
                  data-area={area.spec.id}
                  style={{ width: `${percent}%` }}
                />
              </div>
              <ul className="chips">
                {area.agentIds.map((id) => {
                  const agent = state.agents[id]!;
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        className="chip"
                        data-testid="agent-chip"
                        data-agent={id}
                        data-status={agent.status}
                        aria-pressed={selected === id}
                        onClick={() => onSelect(id)}
                      >
                        <span className="chip-dot" data-status={agent.status} aria-hidden="true" />
                        {agent.spec.name}
                        <span className="sr-only"> ({STATUS_LABEL[agent.status]})</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
