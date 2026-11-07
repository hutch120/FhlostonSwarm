import { create } from "zustand";
import type { MotionMode } from "../swarm/layout.js";

export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface UiStore {
  motion: MotionMode;
  setMotion: (motion: MotionMode) => void;
}

/** Honours the OS reduced-motion preference by default; users can still pick any mode. */
export const useUiStore = create<UiStore>((set) => ({
  motion: prefersReducedMotion() ? "reduced" : "full",
  setMotion: (motion) => set({ motion }),
}));
