import type { AgentSpec, AreaSpec } from "@swarm/shared";

export type MotionMode = "full" | "low-power" | "reduced";

export interface AgentSlot {
  id: string;
  area: string;
  /** Radians; the area's sector is centred on its own angle, starting at the top. */
  angle: number;
  /** Fraction (0..1) of the usable radius. */
  radius: number;
  phase: number;
}

export interface AreaSector {
  id: string;
  start: number;
  end: number;
  centre: number;
}

const TAU = Math.PI * 2;
const TOP = -Math.PI / 2;

export function layoutSectors(areas: readonly AreaSpec[]): AreaSector[] {
  const span = TAU / Math.max(1, areas.length);
  return areas.map((a, i) => {
    const centre = TOP + i * span;
    return { id: a.id, start: centre - span / 2, end: centre + span / 2, centre };
  });
}

/** Agents of an area fan out inside its sector, alternating between two rings. */
export function layoutSlots(agents: readonly AgentSpec[], areas: readonly AreaSpec[]): AgentSlot[] {
  const sectors = layoutSectors(areas);
  const slots: AgentSlot[] = [];
  const span = TAU / Math.max(1, areas.length);
  for (const sector of sectors) {
    const members = agents.filter((a) => a.area === sector.id);
    const step = span * 0.3;
    members.forEach((agent, j) => {
      slots.push({
        id: agent.id,
        area: sector.id,
        angle: sector.centre + (j - (members.length - 1) / 2) * step,
        radius: j % 2 === 0 ? 0.6 : 0.78,
        phase: slots.length * 1.7,
      });
    });
  }
  return slots;
}

export interface Point {
  x: number;
  y: number;
}

export function usableRadius(width: number, height: number): number {
  return Math.max(10, Math.min(width, height) / 2 - 34);
}

/** Position of an agent at time `t` seconds; reduced motion holds every agent still. */
export function slotPoint(
  slot: AgentSlot,
  width: number,
  height: number,
  t: number,
  motion: MotionMode,
): Point {
  const r = usableRadius(width, height);
  const wobble = motion === "reduced" ? 0 : 1;
  const angle = slot.angle + wobble * Math.sin(t * 0.35 + slot.phase) * 0.05;
  const radius = r * slot.radius + wobble * Math.sin(t * 0.5 + slot.phase * 1.3) * r * 0.025;
  return { x: width / 2 + Math.cos(angle) * radius, y: height / 2 + Math.sin(angle) * radius };
}
