import { selectAreas, type AgentFace, type RunState } from "@swarm/shared";
import { theme } from "../theme.js";
import type { Effect } from "./effects.js";
import {
  layoutSectors,
  slotPoint,
  usableRadius,
  type AgentSlot,
  type MotionMode,
  type Point,
} from "./layout.js";

export interface Scene {
  width: number;
  height: number;
  /** Seconds on the canvas clock. */
  t: number;
  state: RunState;
  slots: readonly AgentSlot[];
  effects: readonly Effect[];
  motion: MotionMode;
  selected: string | null;
  target: string;
}

const TAU = Math.PI * 2;
const BODY = "#0a1124";

export function rgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const withGlow = (ctx: CanvasRenderingContext2D, on: boolean, colour: string, blur: number) => {
  ctx.shadowColor = on ? colour : "transparent";
  ctx.shadowBlur = on ? blur : 0;
};

export function agentPoints(scene: Scene): Map<string, Point> {
  const points = new Map<string, Point>();
  for (const slot of scene.slots) {
    points.set(slot.id, slotPoint(slot, scene.width, scene.height, scene.t, scene.motion));
  }
  return points;
}

/** Nearest agent to a canvas point, if any is within the hit radius. */
export function hitTest(scene: Scene, point: Point, radius = 30): string | null {
  let best: { id: string; d: number } | null = null;
  for (const [id, p] of agentPoints(scene)) {
    const d = Math.hypot(p.x - point.x, p.y - point.y);
    if (d <= radius && (!best || d < best.d)) best = { id, d };
  }
  return best?.id ?? null;
}

function drawFace(
  ctx: CanvasRenderingContext2D,
  face: AgentFace,
  p: Point,
  r: number,
  colour: string,
  alpha: number,
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = BODY;
  ctx.strokeStyle = colour;
  ctx.lineWidth = 2;

  ctx.beginPath();
  if (face === "hex") {
    for (let i = 0; i < 6; i++) {
      const a = (TAU / 6) * i - Math.PI / 6;
      const x = p.x + Math.cos(a) * r * 1.08;
      const y = p.y + Math.sin(a) * r * 1.08;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  } else {
    ctx.arc(p.x, p.y, r, 0, TAU);
  }
  ctx.fill();
  ctx.stroke();

  if (face === "ears") {
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(p.x + side * r * 0.35, p.y - r * 0.85);
      ctx.lineTo(p.x + side * r * 0.85, p.y - r * 1.45);
      ctx.lineTo(p.x + side * r * 0.95, p.y - r * 0.45);
      ctx.closePath();
      ctx.fillStyle = BODY;
      ctx.fill();
      ctx.stroke();
    }
  }

  ctx.fillStyle = colour;
  if (face === "visor") {
    ctx.fillRect(p.x - r * 0.62, p.y - r * 0.28, r * 1.24, r * 0.34);
  } else if (face === "cyclops") {
    ctx.beginPath();
    ctx.arc(p.x, p.y - r * 0.04, r * 0.34, 0, TAU);
    ctx.fill();
    ctx.fillStyle = BODY;
    ctx.beginPath();
    ctx.arc(p.x, p.y - r * 0.04, r * 0.13, 0, TAU);
    ctx.fill();
  } else {
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(p.x + side * r * 0.34, p.y - r * 0.08, r * 0.15, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawEffect(
  ctx: CanvasRenderingContext2D,
  e: Effect,
  scene: Scene,
  points: Map<string, Point>,
  core: Point,
  colourOfAgent: (id: string | null) => string,
) {
  const age = scene.t - e.born;
  const k = Math.min(1, Math.max(0, age / e.ttl));
  const colour = e.colour ?? colourOfAgent(e.agent);
  const at = e.agent ? points.get(e.agent) : undefined;
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = rgba(colour, 1 - k);
  ctx.fillStyle = rgba(colour, 1 - k);

  switch (e.kind) {
    case "probe": {
      if (!at) break;
      const x = at.x + (core.x - at.x) * k;
      const y = at.y + (core.y - at.y) * k;
      withGlow(ctx, scene.motion === "full", colour, 12);
      ctx.beginPath();
      ctx.arc(x, y, 3.2, 0, TAU);
      ctx.fill();
      break;
    }
    case "clear":
    case "gap":
    case "verify": {
      if (!at) break;
      if (e.kind === "gap") ctx.setLineDash([4, 4]);
      withGlow(ctx, scene.motion === "full", colour, 10);
      ctx.beginPath();
      ctx.arc(at.x, at.y, 18 + k * 20, 0, TAU);
      ctx.stroke();
      break;
    }
    case "dispatch": {
      if (!at) break;
      ctx.beginPath();
      ctx.arc(at.x, at.y, 42 - k * 24, 0, TAU);
      ctx.stroke();
      break;
    }
    case "finding": {
      if (!at) break;
      withGlow(ctx, scene.motion === "full", colour, 18);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(at.x, at.y, 16 + k * 46, 0, TAU);
      ctx.stroke();
      for (let i = 0; i < 8; i++) {
        const a = (TAU / 8) * i + 0.4;
        const d = 12 + k * 54;
        ctx.beginPath();
        ctx.arc(at.x + Math.cos(a) * d, at.y + Math.sin(a) * d, 2.4 * (1 - k) + 0.6, 0, TAU);
        ctx.fill();
      }
      break;
    }
    case "complete": {
      withGlow(ctx, scene.motion === "full", colour, 22);
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(core.x, core.y, 20 + k * usableRadius(scene.width, scene.height), 0, TAU);
      ctx.stroke();
      break;
    }
  }
  ctx.restore();
}

/** Paints one frame. Pure with respect to its inputs, so it is safe to call from any driver. */
export function drawScene(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const { width: w, height: h, t, state, motion } = scene;
  const full = motion === "full";
  ctx.clearRect(0, 0, w, h);
  const core: Point = { x: w / 2, y: h / 2 };
  const R = usableRadius(w, h);
  const points = agentPoints(scene);
  const colourOfAgent = (id: string | null) =>
    (id && state.agents[id]?.spec.colour) || theme.colour.accent;

  // Area ring segments with their progress.
  const sectors = layoutSectors(state.areas);
  const progress = selectAreas(state);
  ctx.lineCap = "round";
  sectors.forEach((sector, i) => {
    const colour = theme.area[sector.id as keyof typeof theme.area] ?? theme.colour.accent;
    const gap = 0.06;
    const start = sector.start + gap;
    const end = sector.end - gap;
    ctx.lineWidth = 4;
    ctx.strokeStyle = rgba(colour, 0.16);
    ctx.beginPath();
    ctx.arc(core.x, core.y, R * 0.98, start, end);
    ctx.stroke();
    const done = progress[i]?.progress ?? 0;
    if (done > 0) {
      withGlow(ctx, full, colour, 10);
      ctx.strokeStyle = rgba(colour, 0.95);
      ctx.beginPath();
      ctx.arc(core.x, core.y, R * 0.98, start, start + (end - start) * done);
      ctx.stroke();
      withGlow(ctx, false, colour, 0);
    }
  });

  // Core.
  const complete = state.status === "complete";
  const coreColour = complete ? theme.colour.success : theme.colour.accent;
  const pulse = full ? Math.sin(t * 2.2) * 2.5 : 0;
  const coreR = 24 + pulse;
  const halo = ctx.createRadialGradient(core.x, core.y, 2, core.x, core.y, coreR * 2.6);
  halo.addColorStop(0, rgba(coreColour, 0.55));
  halo.addColorStop(1, rgba(coreColour, 0));
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(core.x, core.y, coreR * 2.6, 0, TAU);
  ctx.fill();
  ctx.fillStyle = BODY;
  ctx.strokeStyle = coreColour;
  ctx.lineWidth = 2.5;
  withGlow(ctx, full, coreColour, 16);
  ctx.beginPath();
  ctx.arc(core.x, core.y, coreR, 0, TAU);
  ctx.fill();
  ctx.stroke();
  withGlow(ctx, false, coreColour, 0);
  ctx.fillStyle = theme.colour.textMuted;
  ctx.font = `11px ${theme.font.mono}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(scene.target, core.x, core.y + coreR + 8);

  // Beams from working agents to the core.
  for (const id of state.agentOrder) {
    const agent = state.agents[id];
    const p = points.get(id);
    if (!agent || !p || agent.status !== "working") continue;
    ctx.save();
    ctx.strokeStyle = rgba(agent.spec.colour, 0.38);
    ctx.lineWidth = 1.4;
    if (full) {
      ctx.setLineDash([5, 7]);
      ctx.lineDashOffset = -t * 36;
    }
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(core.x, core.y);
    ctx.stroke();
    ctx.restore();
  }

  // Agents.
  const labels = w >= 420;
  for (const id of state.agentOrder) {
    const agent = state.agents[id];
    const p = points.get(id);
    if (!agent || !p) continue;
    const alpha = agent.status === "idle" ? 0.38 : agent.status === "done" ? 0.7 : 1;
    const r = 15;
    if (scene.selected === id) {
      ctx.strokeStyle = rgba(theme.colour.text, 0.9);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 9, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    withGlow(ctx, full && agent.status === "working", agent.spec.colour, 16);
    drawFace(ctx, agent.spec.face, p, r, agent.spec.colour, alpha);
    withGlow(ctx, false, agent.spec.colour, 0);
    if (agent.status === "done") {
      ctx.strokeStyle = rgba(theme.colour.success, 0.85);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x + r * 0.9, p.y + r * 0.9, 5, 0, TAU);
      ctx.fillStyle = BODY;
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p.x + r * 0.9 - 2.4, p.y + r * 0.9);
      ctx.lineTo(p.x + r * 0.9 - 0.6, p.y + r * 0.9 + 2);
      ctx.lineTo(p.x + r * 0.9 + 2.6, p.y + r * 0.9 - 2);
      ctx.stroke();
    }
    if (labels) {
      ctx.fillStyle = rgba(theme.colour.text, agent.status === "idle" ? 0.45 : 0.85);
      ctx.font = `10px ${theme.font.mono}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(agent.spec.name, p.x, p.y + r + 6);
    }
  }

  for (const e of scene.effects) drawEffect(ctx, e, scene, points, core, colourOfAgent);
}
