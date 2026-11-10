import { describe, expect, it } from "vitest";
import { finalizeInput } from "./orchestrator.js";
import { channelFor } from "./publisher.js";

const owner = "a".repeat(64);

describe("finalize input from the state machine", () => {
  it("takes the ECS task times as the state machine delivers them: epoch seconds, milliseconds or ISO", () => {
    const parsed = finalizeInput.parse({
      owner,
      runId: "run_abc12345",
      task: {
        pullStartedAt: 1_762_754_924.523,
        startedAt: 1_762_754_950_123,
        stoppedAt: "2026-11-10T07:30:00.000Z",
      },
    });
    expect(parsed.task).toEqual({
      pullStartedAt: "2025-11-10T06:08:44.523Z",
      startedAt: "2025-11-10T06:09:10.123Z",
      stoppedAt: "2026-11-10T07:30:00.000Z",
    });
  });

  it("accepts a failed run that never had a task, and ignores the rest of the state", () => {
    const parsed = finalizeInput.parse({
      owner,
      runId: "run_abc12345",
      prepared: { token: "secret", maxSeconds: 900 },
      error: { Error: "States.TaskFailed", Cause: "..." },
    });
    expect(parsed.task).toBeUndefined();
    expect(parsed.error).toBeDefined();
    expect(parsed).not.toHaveProperty("prepared");
  });

  it("refuses an owner that is not a hash", () => {
    expect(finalizeInput.safeParse({ owner: "x", runId: "run_abc12345" }).success).toBe(false);
  });
});

describe("live channel names", () => {
  it("use only letters, digits and hyphens (AppSync Events rejects underscores)", () => {
    expect(channelFor("run_0mwadchjf724d5fea1438")).toBe("/runs/run-0mwadchjf724d5fea1438");
    expect(channelFor("run_abc12345")).toMatch(/^\/runs\/[A-Za-z0-9-]+$/);
  });
});
