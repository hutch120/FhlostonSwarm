import { describe, expect, it } from "vitest";
import { parseRunId } from "./index.js";

describe("@swarm/shared is resolvable from @swarm/api", () => {
  it("parses a run id via the shared schema", () => {
    expect(parseRunId("run_abc12345")).toBe("run_abc12345");
    expect(() => parseRunId("nope")).toThrow();
  });
});
