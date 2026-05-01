import * as os from 'node:os'

import type { CircuitBreaker } from './CircuitBreaker'

/**
 * Static machine metadata included in every performance cycle log.
 * Computed once at module load — these values don't change during
 * the extension host's lifetime.
 */
export const machineContext = {
  cpuCount: os.cpus().length,
  totalMemGB: Math.round(os.totalmem() / 1024 ** 3),
  nodeVersion: process.version,
}

/**
 * Build the base heartbeat data object shared by all monitor poll cycles.
 * Extracts the duplicated pattern that was repeated in success+failure
 * paths across CopilotMonitor, CursorMonitor, and CursorTabMonitor
 * (Finding 6 from PR review).
 */
export function buildCycleHeartbeat(opts: {
  cpuBefore: NodeJS.CpuUsage
  heapBefore: number
  cycleStart: number
  breaker: CircuitBreaker
  extra?: Record<string, unknown>
}): Record<string, unknown> {
  const cpuDelta = process.cpuUsage(opts.cpuBefore)
  const heapAfter = process.memoryUsage().heapUsed
  return {
    cycleDurationMs: Date.now() - opts.cycleStart,
    cpuUserUs: cpuDelta.user,
    cpuSystemUs: cpuDelta.system,
    heapDeltaBytes: heapAfter - opts.heapBefore,
    heapUsedBytes: heapAfter,
    breakerIntervalMs: opts.breaker.currentInterval,
    breakerFailures: opts.breaker.failures,
    transientErrors: opts.breaker.transientErrors,
    ...machineContext,
    ...opts.extra,
  }
}
