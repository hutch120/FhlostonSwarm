import { DEMO_TARGET, replayEvents, tiers } from "@swarm/shared";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { AgentDrawer } from "../panels/AgentDrawer.js";
import { AreasPanel } from "../panels/AreasPanel.js";
import { Counters } from "../panels/Counters.js";
import { EventLog } from "../panels/EventLog.js";
import { FindingsPanel } from "../panels/FindingsPanel.js";
import { ReplayControls } from "../panels/ReplayControls.js";
import { useReplay } from "../replay/useReplay.js";
import { useRunStore } from "../state/run.js";
import { SwarmCanvas } from "../swarm/SwarmCanvas.js";

const parseSpeed = (raw: string | null): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 64 ? n : 1;
};

/**
 * The hero screen. Phase 2 feeds it from the scripted replay; the real event stream will drive the
 * same store, so nothing here changes when the backend arrives. `?speed=` and `?autoplay=0` tune
 * the replay (used by the smoke test).
 */
export function LiveRun() {
  const { runId } = useParams();
  const [params] = useSearchParams();
  const [selected, setSelected] = useState<string | null>(null);

  useReplay({
    autoplay: params.get("autoplay") !== "0",
    speed: parseSpeed(params.get("speed")),
  });
  const state = useRunStore((s) => s.state);

  const complete = state.status === "complete";
  const announcement = complete
    ? `Run complete. ${state.findings.length} findings. Report assembled.`
    : "";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Live swarm view</h1>
          <p className="muted">
            Target <code>{DEMO_TARGET}</code> · {tiers[state.tier].name} scan
            {runId ? <> · {runId}</> : null}
          </p>
        </div>
        <span className="badge badge-status" data-status={state.status} data-testid="run-status">
          {state.status}
        </span>
      </div>
      <p className="notice" role="note">
        This is a replay of a simulated run ({replayEvents.length} events) against a made-up target.
        No backend is involved.
      </p>

      <ReplayControls />

      {complete && (
        <div className="banner" role="status" data-testid="report-banner">
          <strong>Report assembled.</strong> {state.findings.length} findings from {state.checks}{" "}
          checks. <Link to={`/runs/${state.runId}/report`}>Open the report</Link>
        </div>
      )}

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      <div className="live-grid">
        <div className="stage">
          <SwarmCanvas target={DEMO_TARGET} selected={selected} onSelect={setSelected} />
          <AgentDrawer state={state} agentId={selected} onClose={() => setSelected(null)} />
        </div>
        <div className="side">
          <Counters state={state} />
          <AreasPanel state={state} selected={selected} onSelect={setSelected} />
          <FindingsPanel state={state} />
        </div>
        <div className="log-row">
          <EventLog state={state} />
        </div>
      </div>
    </>
  );
}
