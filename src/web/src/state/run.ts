import {
  DEMO_RUN_ID,
  applyEvent,
  createRunState,
  tierRoster,
  type RunEvent,
  type RunState,
  type TierId,
} from "@swarm/shared";
import { create } from "zustand";

interface RunStore {
  state: RunState;
  apply: (event: RunEvent) => void;
  reset: (init?: { runId?: string; tier?: TierId }) => void;
}

/** A fresh run state with the agents and areas the tier plans to cover. */
const initial = (runId = DEMO_RUN_ID, tier: TierId = "siege") => {
  const { areas, agents } = tierRoster(tier);
  return createRunState({ runId, tier, areas, agents });
};

/** Live run state. The feed (replay or the real event stream) only ever calls `apply`. */
export const useRunStore = create<RunStore>((set) => ({
  state: initial(),
  apply: (event) => set((s) => ({ state: applyEvent(s.state, event) })),
  reset: (init) => set({ state: initial(init?.runId, init?.tier) }),
}));
