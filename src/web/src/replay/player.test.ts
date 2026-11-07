import { replayEvents, type RunEvent } from "@swarm/shared";
import { describe, expect, it, vi } from "vitest";
import { ReplayPlayer } from "./player.js";

function setup(events: readonly RunEvent[] = replayEvents) {
  const seen: RunEvent[] = [];
  const onReset = vi.fn(() => {
    seen.length = 0;
  });
  const onChange = vi.fn();
  const player = new ReplayPlayer(events, { onEvent: (e) => seen.push(e), onReset, onChange });
  return { player, seen, onReset, onChange };
}

describe("ReplayPlayer", () => {
  it("does not emit anything until it is played", () => {
    const { player, seen } = setup();
    player.tick(10_000);
    expect(seen).toHaveLength(0);
  });

  it("emits events in order as the virtual clock reaches them", () => {
    const { player, seen } = setup();
    player.play();
    player.tick(1);
    expect(seen.map((e) => e.seq)).toEqual([1]);
    player.tick(5000);
    expect(seen.length).toBeGreaterThan(5);
    expect(seen.map((e) => e.seq)).toEqual(seen.map((_, i) => i + 1));
  });

  it("scales time by the playback speed", () => {
    const slow = setup();
    slow.player.play();
    slow.player.tick(10_000);
    const fast = setup();
    fast.player.play();
    fast.player.setSpeed(4);
    fast.player.tick(10_000);
    expect(fast.seen.length).toBeGreaterThan(slow.seen.length);
    expect(fast.player.snapshot.positionMs).toBe(40_000);
  });

  it("stops advancing while paused", () => {
    const { player, seen } = setup();
    player.play();
    player.tick(8000);
    const count = seen.length;
    player.pause();
    player.tick(8000);
    expect(seen).toHaveLength(count);
    expect(player.snapshot.playing).toBe(false);
  });

  it("plays through to the final event and then stops", () => {
    const { player, seen } = setup();
    player.play();
    player.tick(player.durationMs + 1);
    expect(seen).toHaveLength(replayEvents.length);
    expect(seen.at(-1)?.type).toBe("complete");
    expect(player.snapshot).toMatchObject({ playing: false, finished: true });
  });

  it("restarts from the beginning, resetting the consumer first", () => {
    const { player, seen, onReset } = setup();
    player.play();
    player.tick(20_000);
    player.restart();
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(0);
    expect(player.snapshot.positionMs).toBe(0);
    player.tick(1);
    expect(seen[0]?.seq).toBe(1);
  });

  it("rewinds on a backwards seek by resetting and replaying up to the target", () => {
    const { player, seen, onReset } = setup();
    player.seek(30_000);
    const forward = seen.length;
    player.seek(10_000);
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(seen.length).toBeLessThan(forward);
    expect(seen.map((e) => e.seq)).toEqual(seen.map((_, i) => i + 1));
  });

  it("skips to the end in one step", () => {
    const { player, seen } = setup();
    player.play();
    player.skipToEnd();
    expect(seen).toHaveLength(replayEvents.length);
    expect(player.snapshot).toMatchObject({ playing: false, finished: true });
  });

  it("starts over when play is pressed after the run finished", () => {
    const { player, onReset } = setup();
    player.skipToEnd();
    player.play();
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(player.snapshot).toMatchObject({ playing: true, finished: false, positionMs: 0 });
  });

  it("reports changes to the observer", () => {
    const { player, onChange } = setup();
    player.setSpeed(2);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ speed: 2 }));
  });
});
