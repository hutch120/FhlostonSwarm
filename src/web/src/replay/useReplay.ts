import { replayEvents, type RunEvent } from "@swarm/shared";
import { useEffect } from "react";
import { create } from "zustand";
import { useRunStore } from "../state/run.js";
import { ReplayPlayer, type ReplaySnapshot } from "./player.js";

interface PlayerStore extends ReplaySnapshot {
  player: ReplayPlayer | null;
}

const idle: ReplaySnapshot = {
  playing: false,
  speed: 1,
  positionMs: 0,
  durationMs: 0,
  finished: false,
};

/** Playback controls state; the controls component reads this and calls the player. */
export const usePlayerStore = create<PlayerStore>(() => ({ ...idle, player: null }));

export interface UseReplayOptions {
  events?: readonly RunEvent[];
  autoplay?: boolean;
  speed?: number;
  tickMs?: number;
}

/** Runs a ReplayPlayer for the lifetime of the component, feeding the shared run store. */
export function useReplay({
  events = replayEvents,
  autoplay = true,
  speed = 1,
  tickMs = 50,
}: UseReplayOptions = {}): void {
  useEffect(() => {
    const { apply, reset } = useRunStore.getState();
    reset({ runId: events[0]?.runId });
    let lastPublished = 0;
    const player = new ReplayPlayer(events, {
      onEvent: apply,
      onReset: () => reset({ runId: events[0]?.runId }),
      onChange: (snapshot) => {
        // Position changes 20 times a second; only publish it a few times a second.
        const positionChanged = snapshot.positionMs !== usePlayerStore.getState().positionMs;
        const now = performance.now();
        const flags =
          snapshot.playing !== usePlayerStore.getState().playing ||
          snapshot.speed !== usePlayerStore.getState().speed ||
          snapshot.finished !== usePlayerStore.getState().finished;
        if (flags || snapshot.finished || (positionChanged && now - lastPublished > 200)) {
          lastPublished = now;
          usePlayerStore.setState(snapshot);
        }
      },
    });
    player.setSpeed(speed);
    usePlayerStore.setState({ player, ...player.snapshot });
    if (autoplay) player.play();

    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      player.tick(now - last);
      last = now;
    }, tickMs);

    return () => {
      clearInterval(timer);
      usePlayerStore.setState({ player: null, ...idle });
    };
  }, [events, autoplay, speed, tickMs]);
}
