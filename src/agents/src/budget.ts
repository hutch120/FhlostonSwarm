/** A run budget was used up. The step in progress, and every later one, is reported as a gap. */
export class BudgetExhausted extends Error {
  constructor(readonly kind: "requests" | "steps" | "time") {
    super(`budget exhausted: ${kind}`);
    this.name = "BudgetExhausted";
  }

  /** The customer-facing wording for the gap event. */
  get reason(): string {
    switch (this.kind) {
      case "requests":
        return "The request budget for this scan depth was used up before this check could run.";
      case "steps":
        return "The check budget for this scan depth was used up before this check could run.";
      case "time":
        return "The time limit for this scan depth was reached before this check could run.";
    }
  }
}

export interface BudgetLimits {
  maxSteps: number;
  maxRequests: number;
  /** Epoch milliseconds after which nothing new may start. */
  deadline: number;
}

/** Per-run limits on checks (steps), requests and wall-clock time, enforced by the runtime, not the prompt. */
export class Budget {
  steps = 0;
  requests = 0;

  constructor(
    private readonly limits: BudgetLimits,
    private readonly now: () => number = Date.now,
  ) {}

  private checkTime(): void {
    if (this.now() >= this.limits.deadline) throw new BudgetExhausted("time");
  }

  /** Call before starting a check. */
  useStep(): void {
    this.checkTime();
    if (this.steps >= this.limits.maxSteps) throw new BudgetExhausted("steps");
    this.steps += 1;
  }

  /** Call before every request. */
  useRequest(): void {
    this.checkTime();
    if (this.requests >= this.limits.maxRequests) throw new BudgetExhausted("requests");
    this.requests += 1;
  }

  /** The run-level gap to report when the budget stopped the run, or null while it has room. */
  exhaustedKind(): BudgetExhausted["kind"] | null {
    if (this.now() >= this.limits.deadline) return "time";
    if (this.steps >= this.limits.maxSteps) return "steps";
    if (this.requests >= this.limits.maxRequests) return "requests";
    return null;
  }
}
