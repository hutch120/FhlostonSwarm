import type { RunEvent } from "@swarm/shared";
import { theme } from "../theme.js";

export type EffectKind =
  "dispatch" | "probe" | "clear" | "finding" | "gap" | "verify" | "steer" | "complete";

export interface Effect {
  kind: EffectKind;
  agent: string | null;
  /** Seconds on the canvas clock when the effect started. */
  born: number;
  ttl: number;
  /** Overrides the agent colour (severity, verdict). */
  colour?: string;
}

const TTL: Record<EffectKind, number> = {
  dispatch: 0.9,
  probe: 0.9,
  clear: 0.8,
  finding: 1.6,
  gap: 1.2,
  verify: 1.2,
  steer: 1.4,
  complete: 2.2,
};

/** Turns a run event into the transient visuals the canvas shows for it. */
export function effectFor(event: RunEvent, now: number): Effect | null {
  const make = (kind: EffectKind, colour?: string): Effect => ({
    kind,
    agent: event.agent,
    born: now,
    ttl: TTL[kind],
    ...(colour ? { colour } : {}),
  });
  switch (event.type) {
    case "dispatch":
      return make("dispatch");
    case "start":
      return make("probe");
    case "finish":
      switch (event.payload.outcome) {
        case "finding":
          return make("finding", theme.severity[event.payload.finding.severity]);
        case "gap":
          return make("gap", theme.colour.textMuted);
        default:
          return make("clear");
      }
    case "verify":
      return make("verify", event.payload.verified ? theme.colour.success : theme.colour.warning);
    case "steer":
      return make("steer", theme.colour.accent);
    case "complete":
      return make("complete", theme.colour.success);
    default:
      return null;
  }
}

/** Visuals worth drawing in low-power mode; the rest is skipped to save battery. */
export const LOW_POWER_KINDS: ReadonlySet<EffectKind> = new Set([
  "finding",
  "verify",
  "steer",
  "complete",
]);
