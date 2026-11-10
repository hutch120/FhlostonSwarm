import { bedrockUsd, type LlmUsage } from "@swarm/shared/server";
import type { LlmRequest, LlmUsageTokens } from "./types.js";

/** A model cap was reached. The check in progress, and every later model-driven one, is a gap. */
export class LlmBudgetExhausted extends Error {
  constructor(readonly kind: "calls" | "tokens" | "spend") {
    super(`model budget exhausted: ${kind}`);
    this.name = "LlmBudgetExhausted";
  }

  /** Customer-facing wording: coverage, never tokens or dollars. */
  get reason(): string {
    return "The coverage limit for this scan depth was reached before this check could finish.";
  }
}

export interface LlmLimits {
  modelId: string;
  /** null means no fixed cap. */
  maxCalls: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  spendCapUsd: number;
}

/** Characters per token used to size a request before it is sent: low on purpose, so the estimate is high. */
const CHARS_PER_TOKEN = 3;

const sizeOf = (request: LlmRequest): number =>
  request.system.length +
  JSON.stringify(request.messages).length +
  JSON.stringify(request.tools).length;

/**
 * Meters every model call and enforces the caps from the runtime, not the prompt. Before a call it
 * assumes the worst (the request as large as it looks, the answer as long as it may be) and refuses
 * if that could pass a cap, so the metered spend can never exceed the cap.
 */
export class LlmMeter {
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  usd = 0;

  constructor(
    readonly limits: LlmLimits,
    private readonly price: (modelId: string, tokens: LlmUsageTokens) => number = bedrockUsd,
  ) {}

  /** Throws `LlmBudgetExhausted` when a call of this size could pass a cap. */
  reserve(request: LlmRequest): void {
    const { limits } = this;
    if (limits.maxCalls !== null && this.calls >= limits.maxCalls) {
      throw new LlmBudgetExhausted("calls");
    }
    const worstInput = Math.ceil(sizeOf(request) / CHARS_PER_TOKEN);
    if (
      (limits.maxInputTokens !== null && this.inputTokens + worstInput > limits.maxInputTokens) ||
      (limits.maxOutputTokens !== null &&
        this.outputTokens + request.maxTokens > limits.maxOutputTokens)
    ) {
      throw new LlmBudgetExhausted("tokens");
    }
    const worstUsd = this.price(limits.modelId, {
      inputTokens: worstInput,
      outputTokens: request.maxTokens,
    });
    if (this.usd + worstUsd > limits.spendCapUsd) throw new LlmBudgetExhausted("spend");
  }

  record(usage: LlmUsageTokens): void {
    this.calls += 1;
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.usd += this.price(this.limits.modelId, usage);
    this.onRecord?.(this.usage());
  }

  /** Called after every model call, so usage can be reported while the run is still going. */
  onRecord?: (usage: LlmUsage) => void;

  usage(): LlmUsage {
    return {
      modelId: this.limits.modelId,
      calls: this.calls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      usd: Math.round(this.usd * 1e6) / 1e6,
    };
  }
}
