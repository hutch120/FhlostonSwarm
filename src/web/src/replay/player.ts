import type { RunEvent } from "@swarm/shared";

export interface ReplayPlayerOptions {
  /** Called for each event as its time comes up. */
  onEvent: (event: RunEvent) => void;
  /** Called before the timeline restarts or rewinds; the consumer should clear its state. */
  onReset: () => void;
  /** Called whenever playing / speed / position changes. */
  onChange?: (snapshot: ReplaySnapshot) => void;
}

export interface ReplaySnapshot {
  playing: boolean;
  speed: number;
  positionMs: number;
  durationMs: number;
  finished: boolean;
}

export const REPLAY_SPEEDS = [1, 2, 4, 8, 16] as const;

/**
 * Feeds a scripted event list to a consumer on a virtual clock. Driven by `tick(dtMs)` so tests
 * (and any timer) can advance it deterministically; it has no timers of its own.
 */
export class ReplayPlayer {
  private readonly offsets: number[];
  private index = 0;
  private position = 0;
  private isPlaying = false;
  private currentSpeed = 1;

  readonly durationMs: number;

  constructor(
    private readonly events: readonly RunEvent[],
    private readonly options: ReplayPlayerOptions,
  ) {
    const first = events.length > 0 ? Date.parse(events[0]!.ts) : 0;
    this.offsets = events.map((e) => Date.parse(e.ts) - first);
    this.durationMs = this.offsets.at(-1) ?? 0;
  }

  get snapshot(): ReplaySnapshot {
    return {
      playing: this.isPlaying,
      speed: this.currentSpeed,
      positionMs: this.position,
      durationMs: this.durationMs,
      finished: this.index >= this.events.length,
    };
  }

  play(): void {
    if (this.index >= this.events.length) this.restart();
    this.isPlaying = true;
    this.emit();
  }

  pause(): void {
    this.isPlaying = false;
    this.emit();
  }

  setSpeed(speed: number): void {
    if (speed > 0) this.currentSpeed = speed;
    this.emit();
  }

  restart(): void {
    this.options.onReset();
    this.index = 0;
    this.position = 0;
    this.emit();
  }

  /** Jump to a point on the timeline, rewinding (and replaying from the start) if needed. */
  seek(ms: number): void {
    const target = Math.min(Math.max(0, ms), this.durationMs);
    if (target < this.position) {
      this.options.onReset();
      this.index = 0;
    }
    this.position = target;
    this.drain();
    this.emit();
  }

  skipToEnd(): void {
    this.seek(this.durationMs);
    this.isPlaying = false;
    this.emit();
  }

  tick(dtMs: number): void {
    if (!this.isPlaying) return;
    this.position = Math.min(this.durationMs, this.position + dtMs * this.currentSpeed);
    this.drain();
    if (this.index >= this.events.length) this.isPlaying = false;
    this.emit();
  }

  private drain(): void {
    while (this.index < this.events.length && this.offsets[this.index]! <= this.position) {
      this.options.onEvent(this.events[this.index]!);
      this.index += 1;
    }
  }

  private emit(): void {
    this.options.onChange?.(this.snapshot);
  }
}
