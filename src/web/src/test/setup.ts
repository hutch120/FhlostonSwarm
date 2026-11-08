import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { mockApi, setApi } from "../api/client.js";
import { useSession } from "../state/session.js";

// jsdom has no canvas, ResizeObserver or matchMedia; the swarm canvas degrades to a no-op without them.
HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub;

// Component tests use the offline mock API and start signed out; tests sign in via the store.
beforeEach(() => {
  setApi(mockApi);
  useSession.getState().setAnonymous();
});

afterEach(() => {
  cleanup();
});
