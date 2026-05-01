/**
 * Main-thread client for the Copilot read worker.
 *
 * Mirrors the pattern used by `cursor/db.ts` — a single long-lived worker
 * serving bounded-size read batches from `CopilotMonitor`. Keeps the
 * extension host responsive even when the worker is busy decoding and
 * splitting multi-MB JSONL files.
 *
 * On a request timeout the worker is forcibly recycled; the pending poll
 * cycle gives up via circuit breaker and the next cycle spawns fresh.
 */

import * as path from 'node:path'
import { Worker } from 'node:worker_threads'

import { logger } from '../shared/logger'

const WORKER_REQUEST_TIMEOUT_MS = 15_000

export type ReadWorkerPerf = {
  queryDurationMs: number
  heapUsedBytes: number
  rssBytes: number
  totalCharsRead: number
  filesRead: number
}

export type ReadFileRequest = { path: string; byteOffset: number }

export type ReadFileResult = {
  path: string
  lines: string[]
  newByteOffset: number
  newFileSize: number
  truncated: boolean
  error: string | null
}

let worker: Worker | null = null
let lastPerf: ReadWorkerPerf | null = null
let isClosing = false
let nextRequestId = 0

/** Crash-loop protection: max 3 restarts within 60s */
const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 60_000
const restartTimestamps: number[] = []

const pendingRequests = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>()

function spawnWorker(): void {
  const workerPath = path.join(__dirname, 'readWorker.js')
  const localWorker = new Worker(workerPath)
  worker = localWorker

  localWorker.on(
    'message',
    (msg: {
      id: number
      result?: unknown
      error?: string
      perf?: ReadWorkerPerf
    }) => {
      // Late message from a worker we already replaced — ignore.
      if (worker !== localWorker) {
        return
      }

      if (msg.id === -1 && msg.error) {
        logger.error(
          { error: msg.error },
          '[readClient] Unhandled rejection in worker'
        )
        return
      }

      const pending = pendingRequests.get(msg.id)
      if (!pending) {
        return
      }
      pendingRequests.delete(msg.id)

      if (msg.error) {
        pending.reject(new Error(msg.error))
      } else {
        lastPerf = msg.perf ?? null
        pending.resolve(msg.result)
      }
    }
  )

  localWorker.on('error', (err: Error) => {
    if (worker !== localWorker) {
      return
    }
    logger.error({ err }, '[readClient] Worker error')
    for (const [id, p] of pendingRequests) {
      p.reject(new Error(`Worker error: ${err.message}`))
      pendingRequests.delete(id)
    }
  })

  localWorker.on('exit', (code) => {
    const isCurrent = worker === localWorker
    if (isCurrent) {
      worker = null
      for (const [id, p] of pendingRequests) {
        p.reject(new Error(`Worker exited with code ${code}`))
        pendingRequests.delete(id)
      }
    }
    if (code !== 0 && !isClosing && isCurrent) {
      logger.warn(
        `[readClient] Worker exited with code ${code}, will restart on next request`
      )
    }
  })
}

function ensureWorker(): boolean {
  if (worker) {
    return true
  }
  if (isClosing) {
    return false
  }

  const now = Date.now()
  while (
    restartTimestamps.length > 0 &&
    now - restartTimestamps[0] > RESTART_WINDOW_MS
  ) {
    restartTimestamps.shift()
  }
  if (restartTimestamps.length >= MAX_RESTARTS) {
    logger.error(
      `[readClient] Worker restart suppressed (${MAX_RESTARTS} restarts in ${RESTART_WINDOW_MS / 1000}s)`
    )
    return false
  }

  restartTimestamps.push(now)
  logger.info('[readClient] Restarting Copilot read worker')
  spawnWorker()
  return !!worker
}

function terminateStuckWorker(reason: string): void {
  if (!worker) {
    return
  }
  const stuck = worker
  worker = null
  // Intentional recycle, not a crash — clear restart budget so a flaky
  // catch-up cycle doesn't permanently disable the worker.
  restartTimestamps.length = 0
  logger.warn(`[readClient] Terminating stuck read worker: ${reason}`)
  for (const [id, p] of pendingRequests) {
    p.reject(new Error(`Read worker terminated: ${reason}`))
    pendingRequests.delete(id)
  }
  stuck.terminate().catch((err: Error) => {
    logger.warn({ err }, '[readClient] Error terminating stuck worker')
  })
}

export async function initReadWorker(): Promise<void> {
  if (worker) {
    return
  }
  isClosing = false
  spawnWorker()
  logger.debug('[readClient] Copilot read worker initialized')
}

export async function closeReadWorker(): Promise<void> {
  isClosing = true
  if (!worker) {
    return
  }
  // Reject all pending requests before terminating so callers don't hang
  // indefinitely — mirrors how db.ts closeDB works.
  for (const [id, p] of pendingRequests) {
    p.reject(new Error('Read worker closing'))
    pendingRequests.delete(id)
  }
  try {
    await worker.terminate()
  } catch {
    // Ignore termination errors
  }
  worker = null
  logger.debug('[readClient] Copilot read worker closed')
}

/**
 * Read new lines from each file (starting at its stored byteOffset) on the
 * worker thread. Parallelism happens *inside* the worker; the main thread
 * sees a single await. Returns empty array if the worker is unavailable
 * (graceful degradation — caller treats as no-op).
 */
export async function readNewLinesBatch(
  files: ReadFileRequest[]
): Promise<ReadFileResult[]> {
  if (files.length === 0) {
    return []
  }
  if (!ensureWorker()) {
    logger.warn(
      '[readClient] Worker unavailable, returning [] for readNewLinesBatch'
    )
    return []
  }

  const id = nextRequestId++
  return new Promise<ReadFileResult[]>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id)
      terminateStuckWorker(`read batch exceeded ${WORKER_REQUEST_TIMEOUT_MS}ms`)
      reject(new Error('Copilot read worker timed out'))
    }, WORKER_REQUEST_TIMEOUT_MS)

    pendingRequests.set(id, {
      resolve: (value) => {
        clearTimeout(timeout)
        resolve(value as ReadFileResult[])
      },
      reject: (err) => {
        clearTimeout(timeout)
        reject(err)
      },
    })

    if (!worker) {
      clearTimeout(timeout)
      pendingRequests.delete(id)
      reject(new Error('Read worker became null after ensureWorker'))
      return
    }
    worker.postMessage({ id, files })
  })
}

/**
 * Perf data from the most recent successful response. Consumed once —
 * returns null after first read until a new response arrives.
 */
export function consumeReadWorkerPerf(): ReadWorkerPerf | null {
  const perf = lastPerf
  lastPerf = null
  return perf
}

export function isReadWorkerAvailable(): boolean {
  return worker !== null
}
