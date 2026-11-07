import { REPLAY_SPEEDS } from "../replay/player.js";
import { usePlayerStore } from "../replay/useReplay.js";
import { formatClock } from "../format.js";
import { useUiStore } from "../state/ui.js";
import type { MotionMode } from "../swarm/layout.js";

const MOTION_LABEL: Record<MotionMode, string> = {
  full: "Full motion",
  "low-power": "Low power",
  reduced: "Reduced motion",
};

/** Dev/demo replay controls: play, pause, speed, scrub and restart. */
export function ReplayControls() {
  const { player, playing, speed, positionMs, durationMs, finished } = usePlayerStore();
  const motion = useUiStore((s) => s.motion);
  const setMotion = useUiStore((s) => s.setMotion);

  return (
    <div className="controls" role="group" aria-label="Replay controls">
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => (playing ? player?.pause() : player?.play())}
        disabled={!player}
      >
        {playing ? "Pause" : finished ? "Replay" : "Play"}
      </button>
      <button type="button" className="btn" onClick={() => player?.restart()} disabled={!player}>
        Restart
      </button>
      <button
        type="button"
        className="btn"
        onClick={() => player?.skipToEnd()}
        disabled={!player || finished}
      >
        Skip to end
      </button>

      <div className="speed" role="group" aria-label="Playback speed">
        {REPLAY_SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            className="btn btn-chip"
            aria-pressed={speed === s}
            onClick={() => player?.setSpeed(s)}
            disabled={!player}
          >
            {s}x
          </button>
        ))}
      </div>

      <label className="scrub">
        <span className="sr-only">Replay position</span>
        <input
          type="range"
          min={0}
          max={durationMs}
          step={100}
          value={positionMs}
          onChange={(e) => player?.seek(Number(e.target.value))}
          disabled={!player}
          aria-valuetext={`${formatClock(positionMs)} of ${formatClock(durationMs)}`}
        />
      </label>
      <span className="clock" data-testid="replay-clock">
        {formatClock(positionMs)} / {formatClock(durationMs)}
      </span>

      <label className="select">
        <span className="sr-only">Motion</span>
        <select value={motion} onChange={(e) => setMotion(e.target.value as MotionMode)}>
          {(Object.keys(MOTION_LABEL) as MotionMode[]).map((m) => (
            <option key={m} value={m}>
              {MOTION_LABEL[m]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
