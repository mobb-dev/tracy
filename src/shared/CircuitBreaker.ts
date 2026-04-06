import { setTimeout } from 'node:timers/promises'

import { logger } from './logger'

export type CircuitBreakerOptions = {
  /** Monitor name for logging */
  name: string
  /** Number of consecutive failures before opening the breaker */
  threshold: number
  /** Cooldown period when breaker is open (ms) */
  cooldownMs: number
  /** Base polling interval (ms) */
  baseIntervalMs: number
  /** Maximum polling interval after backoff (ms) */
  maxIntervalMs: number
  /** Classify an error as transient (skip penalty) vs actual (apply backoff) */
  isTransientError: (err: Error) => boolean
}

/**
 * Circuit breaker with exponential backoff for monitor polling loops.
 * Shared between CopilotMonitor and CursorMonitor.
 */
export class CircuitBreaker {
  private consecutiveFailures = 0
  private interval: number

  constructor(private readonly opts: CircuitBreakerOptions) {
    this.interval = opts.baseIntervalMs
  }

  /** Current polling interval (includes backoff). */
  get currentInterval(): number {
    return this.interval
  }

  /** Compute delay with ±20% jitter to prevent thundering herd. */
  getDelayWithJitter(): number {
    const jitter = this.interval * 0.2 * (Math.random() * 2 - 1)
    return Math.round(this.interval + jitter)
  }

  /** If breaker is open, sleep through cooldown (half-open probe after). */
  async waitIfOpen(signal: AbortSignal): Promise<void> {
    if (this.consecutiveFailures < this.opts.threshold) {
      return
    }

    logger.warn(
      `${this.opts.name} circuit breaker open (${this.consecutiveFailures} failures), cooling down ${this.opts.cooldownMs / 1000}s`
    )
    logger.info(
      { heartbeat: true, data: { failures: this.consecutiveFailures } },
      'circuit breaker open'
    )
    await setTimeout(this.opts.cooldownMs, undefined, { signal })
    // Half-open: allow one probe cycle
    this.consecutiveFailures = this.opts.threshold - 1
  }

  /** Record a successful cycle — reset backoff. */
  recordSuccess(): void {
    this.consecutiveFailures = 0
    this.interval = this.opts.baseIntervalMs
  }

  /** Record a failure. Returns whether it was transient (no penalty). */
  recordFailure(err: Error): { isTransient: boolean } {
    const errMsg = err.message ?? String(err)
    if (this.opts.isTransientError(err)) {
      logger.warn({ err }, `${this.opts.name} transient error, skipping cycle`)
      return { isTransient: true }
    }

    this.consecutiveFailures++
    this.interval = Math.min(
      this.opts.baseIntervalMs * Math.pow(2, this.consecutiveFailures - 1),
      this.opts.maxIntervalMs
    )
    logger.error({ err }, `Error in ${this.opts.name} polling`)
    logger.info(
      { heartbeat: true, data: { error: errMsg.slice(0, 100) } },
      `poll error (${this.consecutiveFailures}x), next in ${Math.round(this.interval / 1000)}s`
    )
    return { isTransient: false }
  }
}
