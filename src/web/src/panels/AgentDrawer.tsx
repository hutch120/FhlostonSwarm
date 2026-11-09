import { TIERS, tiers, type RunState } from "@swarm/shared";
import { useId } from "react";
import { capitalise } from "../format.js";

interface Props {
  state: RunState;
  agentId: string | null;
  onClose: () => void;
}

const OUTCOME_LABEL = { clear: "clear", info: "info", finding: "finding", gap: "gap" } as const;

const joinNames = (names: string[]) =>
  names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
const steeredTiers = joinNames(TIERS.filter((t) => t.steering).map((t) => t.name));
const watchOnlyTiers = joinNames(TIERS.filter((t) => !t.steering).map((t) => t.name));

/** Detail for the selected agent, with the steering box present but disabled until Phase 8. */
export function AgentDrawer({ state, agentId, onClose }: Props) {
  const steerId = useId();
  const agent = agentId ? state.agents[agentId] : undefined;
  if (!agent) return null;
  const area = state.areas.find((a) => a.id === agent.spec.area);
  const steering = tiers[state.tier].steering;
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

      <form className="steer" onSubmit={(e) => e.preventDefault()}>
        <label htmlFor={steerId} className="drawer-sub">
          Steer this agent
        </label>
        <textarea
          id={steerId}
          rows={3}
          disabled
          placeholder="e.g. Look harder at the file upload"
          aria-describedby={`${steerId}-hint`}
        />
        <p id={`${steerId}-hint`} className="muted">
          {steering
            ? "Steering arrives in a later release; it is switched off in this preview."
            : `Steering is available on ${steeredTiers} scans. ${watchOnlyTiers} scans are watch-only.`}
        </p>
        <button type="submit" className="btn" disabled>
          Send
        </button>
      </form>
    </aside>
  );
}
