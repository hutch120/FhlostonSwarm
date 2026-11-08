import type { RunEvent, RunState, Severity } from "@swarm/shared";

export type Tone = "neutral" | "clear" | "info" | "finding" | "gap" | "verified" | "steer" | "done";

export interface LogLine {
  seq: number;
  ts: string;
  who: string;
  text: string;
  tone: Tone;
  severity?: Severity;
}

const nameOf = (state: Pick<RunState, "agents">, id: string | null) =>
  id === null ? "swarm" : (state.agents[id]?.spec.name ?? id);

/** One human-readable line per event, for the event log. */
export function describeEvent(state: Pick<RunState, "agents">, e: RunEvent): LogLine {
  const who = nameOf(state, e.agent);
  const line = (text: string, tone: Tone, severity?: Severity): LogLine => ({
    seq: e.seq,
    ts: e.ts,
    who,
    text,
    tone,
    ...(severity ? { severity } : {}),
  });
  switch (e.type) {
    case "dispatch":
      return line(`dispatched: ${e.payload.task}`, "neutral");
    case "start":
      return line(`started: ${e.payload.label}`, "neutral");
    case "finish": {
      const p = e.payload;
      if (p.outcome === "clear") return line(`clear: ${p.label}`, "clear");
      if (p.outcome === "info") return line(`${p.label}: ${p.note}`, "info");
      if (p.outcome === "gap") return line(`could not test: ${p.label}`, "gap");
      return line(
        `${p.finding.id} ${p.finding.severity}: ${p.finding.title}`,
        "finding",
        p.finding.severity,
      );
    }
    case "verify":
      return line(
        `${e.payload.verified ? "verified" : "could not verify"} ${e.payload.findingId}: ${e.payload.note}`,
        e.payload.verified ? "verified" : "gap",
      );
    case "agent-done":
      return line(`done: ${e.payload.summary}`, "done");
    case "gap":
      return line(`scope gap: ${e.payload.reason}`, "gap");
    case "steer":
      return line(`steering: ${e.payload.message}`, "steer");
    case "complete":
      return line("run complete, report assembled", "done");
  }
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });

export const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
