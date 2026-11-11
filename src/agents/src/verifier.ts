import type { Finding } from "@swarm/shared";
import { BudgetExhausted } from "./budget.js";
import type { Emitter } from "./emitter.js";
import type { AgentModule, Replay, ReplayResult, StepContext } from "./types.js";

/** A finding raised during the run, with how to repeat the observation. */
export interface Candidate {
  finding: Finding;
  stepId: string;
  /** Repeats the observation on its own; without one the whole check is re-run in a fresh context. */
  replay?: Replay;
}

export interface VerifyDeps {
  emitter: Emitter;
  /** The id the cross-check events carry. */
  verifier: string;
  modules: Record<string, AgentModule>;
  /** A context with nothing cached from the original check. */
  freshContext(): StepContext;
  /** Scrubs credentials and tokens from the note before it becomes an event. */
  redact(text: string): string;
  aborted?: () => boolean;
  onVerdict?(findingId: string, verified: boolean): void;
}

export interface VerifySummary {
  confirmed: number;
  unconfirmed: number;
  /** Candidates not re-tested because a limit was reached; they stay unverified. */
  notChecked: number;
}

/** Re-runs the check that raised the finding, with nothing carried over from the first run. */
async function rerun(candidate: Candidate, deps: VerifyDeps): Promise<ReplayResult> {
  const { finding } = candidate;
  const step = deps.modules[finding.agent]?.steps[candidate.stepId];
  if (!step)
    return { confirmed: null, note: "The check that raised this finding could not be repeated." };
  const again = await step(deps.freshContext());
  return again.outcome === "finding"
    ? {
        confirmed: true,
        note: `Ran the "${finding.agent}" check again from scratch and it raised the same kind of issue.`,
      }
    : {
        confirmed: false,
        note: `Ran the "${finding.agent}" check again from scratch and it did not raise the issue.`,
      };
}

const wording = (result: ReplayResult): string =>
  result.confirmed === true
    ? `Reproduced. ${result.note}`
    : result.confirmed === false
      ? `Could not be reproduced. ${result.note}`
      : `Could not be re-tested independently. ${result.note}`;

/**
 * The verifier stage (PLAN.md section 7, step 4): every candidate finding is re-tested on its own,
 * with fresh requests and no state from the first look. Confirmed findings become `open`; anything
 * that did not reproduce, or could not be re-tested, is marked unconfirmed and says why. It never
 * upgrades a finding on a guess: no evidence, no verification.
 */
export async function verifyCandidates(
  candidates: readonly Candidate[],
  deps: VerifyDeps,
): Promise<VerifySummary> {
  const summary: VerifySummary = { confirmed: 0, unconfirmed: 0, notChecked: 0 };
  for (const [index, candidate] of candidates.entries()) {
    if (deps.aborted?.()) {
      summary.notChecked += candidates.length - index;
      break;
    }
    let result: ReplayResult;
    try {
      result = candidate.replay ? await candidate.replay() : await rerun(candidate, deps);
    } catch (err) {
      if (err instanceof BudgetExhausted) {
        summary.notChecked += candidates.length - index;
        break;
      }
      console.error(
        JSON.stringify({
          msg: "verify_failed",
          finding: candidate.finding.id,
          name: (err as Error).name,
        }),
      );
      result = { confirmed: null, note: "The re-test failed unexpectedly." };
    }
    const verified = result.confirmed === true;
    deps.emitter.verify(
      deps.verifier,
      candidate.finding.id,
      verified,
      deps.redact(wording(result)).slice(0, 500),
    );
    deps.onVerdict?.(candidate.finding.id, verified);
    if (verified) summary.confirmed += 1;
    else summary.unconfirmed += 1;
  }
  return summary;
}
