/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-api-circuit-breaker.ts: A small error-counting circuit breaker that keeps us from hammering a struggling Protect controller.
 */

/**
 * The outcome of checking the circuit breaker before a request.
 *
 * - `closed`  - all is well, the request may proceed.
 * - `tripped` - the error threshold was just crossed. The request must not proceed and the caller should inform the user and tear down its connections.
 * - `open`    - we're still in the penalty box. The request must not proceed.
 * - `resumed` - the penalty interval has elapsed and the breaker has been reset. The request may proceed, after reestablishing any session state.
 *
 * @internal
 */
export type CircuitBreakerState = 'closed' | 'open' | 'resumed' | 'tripped';

/**
 * Count consecutive API errors and, once a threshold is reached, pause all communication for a fixed interval before trying again.
 *
 * @internal
 */
export class CircuitBreaker {

  private _errorCount: number;
  private _isThrottled: boolean;
  private readonly errorLimit: number;
  private readonly now: () => number;
  private readonly retryInterval: number;
  private throttleStart: number;

  /**
   * @param errorLimit    - Number of consecutive errors to accept before we begin throttling.
   * @param retryInterval - Interval, in milliseconds, to pause communication once throttled.
   * @param now           - Clock source. Defaults to `Date.now()`.
   */
  constructor(errorLimit: number, retryInterval: number, now: () => number = (): number => Date.now()) {

    this._errorCount = 0;
    this._isThrottled = false;
    this.errorLimit = errorLimit;
    this.now = now;
    this.retryInterval = retryInterval;
    this.throttleStart = 0;
  }

  // Check whether a request may proceed, transitioning the breaker state as needed.
  public check(): CircuitBreakerState {

    // We're under the error threshold - all clear.
    if(!this.isOverLimit) {

      return 'closed';
    }

    const now = this.now();

    // We've just crossed the threshold. Start the penalty interval.
    if(!this._isThrottled) {

      this.throttleStart = now;
      this._isThrottled = true;

      return 'tripped';
    }

    // We're still in the penalty box.
    if((now - this.throttleStart) < this.retryInterval) {

      return 'open';
    }

    // We're out of the penalty box. Reset and allow traffic to flow again.
    this._errorCount = 0;
    this._isThrottled = false;

    return 'resumed';
  }

  // Record a failed request.
  public recordFailure(): void {

    this._errorCount++;
  }

  // Record a successful request, clearing any accumulated errors.
  public recordSuccess(): void {

    this._errorCount = 0;
    this._isThrottled = false;
  }

  // The number of consecutive errors we've seen.
  public get errorCount(): number {

    return this._errorCount;
  }

  // Whether we've reached the error threshold.
  public get isOverLimit(): boolean {

    return this._errorCount >= this.errorLimit;
  }

  // Whether we're currently throttling requests.
  public get isThrottled(): boolean {

    return this._isThrottled;
  }
}
