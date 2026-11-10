/** Spaces calls so no more than `perSecond` start per second, with a burst of at most one second's worth. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly perSecond: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.tokens = Math.max(1, perSecond);
    this.last = now();
  }

  /** Resolves when a token is available. Calls are served in order. */
  async take(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = Math.ceil(((1 - this.tokens) / this.perSecond) * 1000);
    this.tokens -= 1;
    await this.sleep(waitMs);
    this.refill();
  }

  private refill(): void {
    const at = this.now();
    const capacity = Math.max(1, this.perSecond);
    this.tokens = Math.min(capacity, this.tokens + ((at - this.last) / 1000) * this.perSecond);
    this.last = at;
  }
}
