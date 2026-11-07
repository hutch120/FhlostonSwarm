import { AGENTS, AREAS } from "@swarm/shared";
import { describe, expect, it } from "vitest";
import { agentPoints, hitTest, type Scene } from "./draw.js";
import { layoutSectors, layoutSlots, slotPoint } from "./layout.js";

const slots = layoutSlots(AGENTS, AREAS);

describe("swarm layout", () => {
  it("places every agent once, inside its area's sector", () => {
    expect(slots).toHaveLength(AGENTS.length);
    const sectors = Object.fromEntries(layoutSectors(AREAS).map((s) => [s.id, s]));
    for (const slot of slots) {
      const sector = sectors[slot.area]!;
      expect(slot.angle).toBeGreaterThanOrEqual(sector.start);
      expect(slot.angle).toBeLessThanOrEqual(sector.end);
    }
  });

  it("keeps agents apart from each other and off the core", () => {
    const pts = slots.map((s) => slotPoint(s, 600, 600, 0, "full"));
    for (let i = 0; i < pts.length; i++) {
      expect(Math.hypot(pts[i]!.x - 300, pts[i]!.y - 300)).toBeGreaterThan(80);
      for (let j = i + 1; j < pts.length; j++) {
        expect(Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.y - pts[j]!.y)).toBeGreaterThan(30);
      }
    }
  });

  it("orbits with full motion and holds still in reduced motion", () => {
    const slot = slots[0]!;
    expect(slotPoint(slot, 600, 600, 1, "full")).not.toEqual(slotPoint(slot, 600, 600, 9, "full"));
    expect(slotPoint(slot, 600, 600, 1, "reduced")).toEqual(
      slotPoint(slot, 600, 600, 9, "reduced"),
    );
  });

  it("hit-tests the nearest agent", () => {
    const scene = { width: 600, height: 600, t: 0, slots, motion: "reduced" } as unknown as Scene;
    const target = agentPoints(scene).get("tls")!;
    expect(hitTest(scene, { x: target.x + 3, y: target.y - 2 })).toBe("tls");
    expect(hitTest(scene, { x: 300, y: 300 })).toBeNull();
  });
});
