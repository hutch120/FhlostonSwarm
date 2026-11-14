import type { RunState } from "@swarm/shared";
import { capitalise } from "../format.js";

interface Props {
  state: RunState;
  agentId: string | null;
  onClose: () => void;
}

const OUTCOME_LABEL = { clear: "clear", info: "info", finding: "finding", gap: "gap" } as const;

/** Detail for the selected agent. */
export function AgentDrawer({ state, agentId, onClose }: Props) {
  const agent = agentId ? state.agents[agentId] : undefined;
  if (!agent) return null;
  const area = state.areas.find((a) => a.id === agent.spec.area);
  const recent = agent.history.slice(-6).reverse();

  return (
    <aside
      className="drawer"
      aria-label={`${agent.spec.name} agent details`}
      data-testid="agent-drawer"
    >
      <header className="drawer-head">
        <div>
          <h2 className="drawer-title">{agent.spec.name} agent</h2>
          <p className="muted">{area?.name}</p>
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onClose}
          aria-label="Close agent details"
        >
          Close
        </button>
      </header>

      <dl className="kv">
        <div>
          <dt>Status</dt>
          <dd data-testid="drawer-status">{capitalise(agent.status)}</dd>
        </div>
        <div>
          <dt>Task</dt>
          <dd>{agent.task ?? "Not dispatched yet"}</dd>
        </div>
        <div>
          <dt>Current step</dt>
          <dd>{agent.currentStep?.label ?? "None"}</dd>
        </div>
        <div>
          <dt>Progress</dt>
          <dd>
            {agent.stepsDone} of {agent.spec.steps.length} steps · {agent.findings} finding
            {agent.findings === 1 ? "" : "s"}
          </dd>
        </div>
      </dl>

      <h3 className="drawer-sub">Recent steps</h3>
      {recent.length === 0 ? (
        <p className="muted">No steps yet.</p>
      ) : (
        <ol className="steps">
          {recent.map((s) => (
            <li key={s.stepId} data-outcome={s.outcome ?? "running"}>
              <span className="step-outcome">
                {s.outcome ? OUTCOME_LABEL[s.outcome] : "running"}
              </span>
              {s.label}
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
