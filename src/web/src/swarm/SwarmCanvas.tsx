import { AGENTS, AREAS, type AgentSpec, type AreaSpec } from "@swarm/shared";
import { useEffect, useMemo, useRef } from "react";
import { useRunStore } from "../state/run.js";
import { useUiStore } from "../state/ui.js";
import { effectFor, LOW_POWER_KINDS, type Effect } from "./effects.js";
import { drawScene, hitTest, type Scene } from "./draw.js";
import { layoutSlots } from "./layout.js";

interface Props {
  target: string;
  selected: string | null;
  onSelect: (agentId: string | null) => void;
  /** The agents and areas to lay out; defaults to the full roster. Pass a stable reference. */
  agents?: readonly AgentSpec[];
  areas?: readonly AreaSpec[];
}

const FRAME_MS: Record<"full" | "low-power", number> = { full: 1000 / 60, "low-power": 1000 / 15 };

/**
 * Canvas 2D swarm: agents orbit a target core, beams show probes and bursts mark findings.
 * Events are read straight from the run store (not via React state) so a 60 fps loop never
 * triggers re-renders. Reduced motion draws a still frame whenever the run state changes.
 */
export function SwarmCanvas({ target, selected, onSelect, agents = AGENTS, areas = AREAS }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const motion = useUiStore((s) => s.motion);
  const slots = useMemo(() => layoutSlots(agents, areas), [agents, areas]);
  const selectedRef = useRef(selected);
  const sceneRef = useRef<Scene | null>(null);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    let width = 0;
    let height = 0;
    let effects: Effect[] = [];
    let seenLog = 0;
    let clock = 0;
    let raf = 0;
    let lastFrame = 0;
    let disposed = false;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const collectEffects = () => {
      const { log } = useRunStore.getState().state;
      if (log.length < seenLog) {
        seenLog = 0;
        effects = [];
      }
      if (motion !== "reduced") {
        for (const event of log.slice(seenLog)) {
          const effect = effectFor(event, clock);
          if (!effect) continue;
          if (motion === "low-power" && !LOW_POWER_KINDS.has(effect.kind)) continue;
          effects.push(effect);
        }
      }
      seenLog = log.length;
      effects = effects.filter((e) => clock - e.born < e.ttl);
    };

    const paint = () => {
      const scene: Scene = {
        width,
        height,
        t: motion === "reduced" ? 0 : clock,
        state: useRunStore.getState().state,
        slots,
        effects,
        motion,
        selected: selectedRef.current,
        target,
      };
      sceneRef.current = scene;
      drawScene(ctx, scene);
    };

    resize();
    const observer = new ResizeObserver(() => {
      resize();
      paint();
    });
    observer.observe(canvas);

    let unsubscribe = () => {};
    if (motion === "reduced") {
      // Still image: repaint only when the run state changes.
      paint();
      unsubscribe = useRunStore.subscribe(() => {
        collectEffects();
        paint();
      });
    } else {
      const frame = FRAME_MS[motion];
      const loop = (now: number) => {
        if (disposed) return;
        raf = requestAnimationFrame(loop);
        if (now - lastFrame < frame - 1) return;
        lastFrame = now;
        clock = now / 1000;
        collectEffects();
        paint();
      };
      raf = requestAnimationFrame(loop);
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      unsubscribe();
    };
  }, [motion, slots, target]);

  // Repaint the selection ring in reduced mode, where there is no animation loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    const scene = sceneRef.current;
    const ctx = canvas?.getContext("2d");
    if (motion === "reduced" && scene && ctx) drawScene(ctx, { ...scene, selected });
  }, [selected, motion]);

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const scene = sceneRef.current;
    if (!scene) return;
    const rect = event.currentTarget.getBoundingClientRect();
    onSelect(hitTest(scene, { x: event.clientX - rect.left, y: event.clientY - rect.top }));
  };

  return (
    <canvas
      ref={canvasRef}
      className="swarm-canvas"
      data-testid="swarm-canvas"
      data-motion={motion}
      role="img"
      aria-label="Swarm visualisation: agents orbiting the target, grouped by test area. The panels beside it list the same information as text."
      onClick={handleClick}
    />
  );
}
