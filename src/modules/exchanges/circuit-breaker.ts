/**
 * Circuit breaker for exchange API calls.
 * - CLOSED: normal operation
 * - OPEN: after `threshold` consecutive failures — calls fail fast
 * - HALF_OPEN: after cooldown, one probe call is allowed
 */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitBreaker {
  private failures = 0;
  private state: CircuitState = "CLOSED";
  private openedAt = 0;

  constructor(
    private threshold = 5,
    private cooldownMs = 60_000,
  ) {}

  get currentState(): CircuitState {
    if (this.state === "OPEN" && Date.now() - this.openedAt > this.cooldownMs) {
      this.state = "HALF_OPEN";
    }
    return this.state;
  }

  get isOpen(): boolean {
    return this.currentState === "OPEN";
  }

  recordSuccess() {
    this.failures = 0;
    this.state = "CLOSED";
  }

  recordFailure() {
    this.failures++;
    if (this.failures >= this.threshold) {
      this.state = "OPEN";
      this.openedAt = Date.now();
    }
  }

  /** Execute fn through the breaker. Throws AppError when open. */
  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.currentState === "OPEN") {
      const { AppError } = await import("@/shared/errors");
      throw new AppError("CIRCUIT_BREAKER_OPEN", 503);
    }
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }
}
