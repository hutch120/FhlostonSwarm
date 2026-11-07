import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// jsdom has no canvas, ResizeObserver or matchMedia; the swarm canvas degrades to a no-op without them.
HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub;

afterEach(() => {
  cleanup();
});
