import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tiers, tierRoster, applyEvents, createRunState } from "@swarm/shared";
import { engagementSchema } from "@swarm/shared/server";
import expected from "@swarm/synthetic-target/expected.json" with { type: "json" };
import { describe, it, vi } from "vitest";
import { MemorySink } from "./emitter.js";
import { BedrockLlm } from "./llm/bedrock.js";
import { runLocal } from "./local.js";
import { browserAvailable, fakeDns, inputFor, launch, stamped, useTarget } from "./testkit.js";

/**
 * The model benchmark (IMPLEMENTATION.md Phase 7, task 6): a Siege run against the synthetic target
 * for each candidate model, scoring discovery quality against the rubric in expected.json and
 * recording cost and time. Off by default: it needs AWS credentials for the swarm account and
 * spends a few dollars. Run with
 * `SWARM_LIVE=1 SWARM_BENCH_MODELS=au.anthropic.claude-sonnet-4-6,au.anthropic.claude-sonnet-5 AWS_PROFILE=swarm AWS_REGION=ap-southeast-2 npx vitest run --project node benchmark.live`
 * and prints one JSON line per model.
 */
vi.setConfig({ testTimeout: 1_800_000 });
const live = process.env["SWARM_LIVE"] === "1" && browserAvailable;
const models = (
  process.env["SWARM_BENCH_MODELS"] ??
  "au.anthropic.claude-sonnet-4-6,au.anthropic.claude-sonnet-5,au.anthropic.claude-sonnet-5-5"
).split(",");
const fixture = useTarget();

describe.skipIf(!live)("model benchmark on the synthetic target", () => {
  for (const modelId of models) {
    it(`Siege with ${modelId}`, async () => {
      const slots = ["admin", "user1", "user2"] as const;
      const base = inputFor(fixture.port(), "siege", { slots: [...slots] });
      const input = {
        ...base,
        budgets: { ...base.budgets, llm: { ...base.budgets.llm, modelId } },
      };
      const sink = new MemorySink();
      const started = Date.now();
      const { result } = await runLocal({
        input,
        sink,
        allowPrivate: true,
        llm: new BedrockLlm({ modelId, region: "ap-southeast-2" }),
        driverFactory: launch,
        dns: fakeDns,
      });
      const seconds = Math.round((Date.now() - started) / 1000);
      const { agents, areas } = tierRoster("siege");
      const state = applyEvents(
        createRunState({ runId: input.runId, tier: "siege", areas, agents }),
        stamped(sink),
      );

      // Discovery rubric: public and signed-in areas, the administrator-only area, the roles.
      const profileText = JSON.stringify(result.profile ?? {}).toLowerCase();
      const rubric = [
        ...expected.app.publicAreas,
        ...expected.app.signedInAreas,
        ...expected.app.adminOnlyAreas,
        ...expected.app.roles,
      ];
      const profileHits = rubric.filter((r) => profileText.includes(r)).length;
      const adminArea = result.profile?.areas.find((a) => /user/i.test(a.name));

      // Ground truth: what the swarm found of what was seeded for a three-login Siege.
      const want = expected.findings.filter(
        (f) =>
          tiers.siege.agents.includes(f.agent) &&
          3 >= ("minLogins" in f ? (f.minLogins ?? 0) : "needsLogin" in f && f.needsLogin ? 1 : 0),
      );
      const found = want.filter((w) =>
        state.findings.some((f) => f.agent === w.agent && f.title.includes(w.titleIncludes)),
      );
      const stray = state.findings.filter(
        (f) => !want.some((w) => w.agent === f.agent && f.title.includes(w.titleIncludes)),
      );
      const plan = result.engagement ? engagementSchema.safeParse(result.engagement) : null;

      const line = JSON.stringify({
        benchmark: modelId,
        seconds,
        usage: result.usage,
        profile: {
          rubricHits: profileHits,
          rubricTotal: rubric.length,
          adminAreaNeedsLogin: adminArea?.requiresLogin ?? null,
          pages: result.profile?.coverage.pagesVisited ?? 0,
          loginsUsed: result.profile?.coverage.loginsUsed ?? 0,
        },
        findings: { recall: `${found.length}/${want.length}`, stray: stray.map((f) => f.title) },
        verification: result.verification,
        plan: { valid: plan?.success ?? false, plannedBy: result.engagement?.plannedBy },
        stoppedBy: result.stoppedBy,
      });
      // Vitest does not always pass console output through; the lines also go to a file.
      appendFileSync(
        process.env["SWARM_BENCH_OUT"] ?? join(tmpdir(), "swarm-bench.jsonl"),
        `${line}\n`,
      );
      console.log(line);
    });
  }
});
