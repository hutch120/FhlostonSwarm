import { describe, expect, it } from "vitest";
import { floodAgent } from "./agents/flood.js";
import { RequestFailed } from "./http.js";
import type { StepContext } from "./types.js";

const contextWith = (status: () => number | typeof RequestFailed) =>
  ({
    appUrl: new URL("http://t.test/"),
    http: {
      request: async () => {
        const s = status();
        if (s === RequestFailed) throw new RequestFailed("blocked");
        return { url: "http://t.test/", status: s, headers: {}, body: "", redirects: [], tls: null };
      },
    },
  }) as unknown as StepContext;

describe("flood.rateLimit", () => {
  it("is informational when some requests are throttled", async () => {
    let n = 0;
    const ctx = contextWith(() => (++n % 3 === 0 ? 429 : 200));
    const result = await floodAgent.steps.rateLimit!(ctx);
    expect(result.outcome).toBe("info");
  });

  it("reports a finding when a burst is never throttled", async () => {
    const ctx = contextWith(() => 200);
    const result = await floodAgent.steps.rateLimit!(ctx);
    expect(result.outcome).toBe("finding");
    if (result.outcome !== "finding") return;
    expect(result.finding.severity).toBe("low");
    expect(result.finding.mapping).toMatch(/API4:2023/);
  });

  it("is a gap when every request is blocked", async () => {
    const ctx = contextWith(() => RequestFailed);
    const result = await floodAgent.steps.rateLimit!(ctx);
    expect(result).toMatchObject({ outcome: "gap" });
  });
});

describe("flood.availability", () => {
  it("is clear when every request answers normally", async () => {
    const ctx = contextWith(() => 200);
    const result = await floodAgent.steps.availability!(ctx);
    expect(result.outcome).toBe("clear");
  });

  it("is informational for a handful of failures", async () => {
    let n = 0;
    const ctx = contextWith(() => (++n % 10 === 0 ? 500 : 200));
    const result = await floodAgent.steps.availability!(ctx);
    expect(result.outcome).toBe("info");
  });

  it("reports a finding when most requests fail under load", async () => {
    let n = 0;
    const ctx = contextWith(() => (++n % 2 === 0 ? 503 : 200));
    const result = await floodAgent.steps.availability!(ctx);
    expect(result.outcome).toBe("finding");
    if (result.outcome !== "finding") return;
    expect(result.finding.severity).toBe("medium");
  });
});
