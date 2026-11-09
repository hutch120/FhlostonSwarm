import {
  AGENTS,
  AREAS,
  DEMO_RUN_ID,
  applyEvent,
  createRunState,
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

const initial = (runId = DEMO_RUN_ID, tier: TierId = "siege") =>
  createRunState({ runId, tier, areas: AREAS, agents: AGENTS });

/** Live run state. The feed (replay today, the real event stream later) only ever calls `apply`. */
export const useRunStore = create<RunStore>((set) => ({
  state: initial(),
  apply: (event) => set((s) => ({ state: applyEvent(s.state, event) })),
  reset: (init) => set({ state: initial(init?.runId, init?.tier) }),
}));
