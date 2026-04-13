/**
 * Database module for interacting with Cursor's SQLite database (state.vscdb).
 * This module provides read-only access to Cursor's internal key-value store.
 *
 * All queries run on a Worker thread to avoid blocking the extension host.
 * Previously used synchronous DatabaseSync on the main thread, which froze
 * Cursor for 1+ seconds on large databases.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { Worker } from 'node:worker_threads'

import * as vscode from 'vscode'

import { logger } from '../shared/logger'
import { SESSION_BUBBLES_LIMIT } from './rawProcessor'
import type { DBRow, SessionRequest, SessionResult } from './types'

/** Re-export so callers that import `DBRow` from `./db` keep working. */
export type { DBRow } from './types'

const WORKER_REQUEST_TIMEOUT_MS = 10_000

/** Worker instance */
let worker: Worker | null = null

/** Stored dbPath for auto-restart after unexpected worker exit */
let storedDbPath: string | null = null

/** Whether closeDB() was called intentionally */
let isClosing = false

/** Crash-loop protection: track restarts within a rolling window */
const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 60_000
const restartTimestamps: number[] = []

/**
 * Ceiling on consecutive timeout-driven recycles. `terminateStuckWorker`
 * intentionally clears `restartTimestamps` (so a flaky DB doesn't trip the
 * crash-loop limit and lock the user out — see T-445), but a *truly* broken
 * DB that hangs every cycle would otherwise spin spawn → timeout → terminate
 * forever with no terminal log. This counter caps that loop.
 */
const MAX_CONSECUTIVE_TIMEOUT_RECYCLES = 10
let consecutiveTimeoutRecycles = 0
let timeoutRecycleSuppressed = false

/** Monotonic request ID counter */
let nextRequestId = 0

/** Pending request callbacks */
const pendingRequests = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>()

/**
 * Spawn a new worker thread and wire up event handlers.
 *
 * All event handlers capture `localWorker` and check `worker === localWorker`
 * before mutating module state. A late event from a worker that was already
 * replaced by `terminateStuckWorker` must NOT clobber the freshly-spawned
 * replacement's state or reject its pending requests.
 */
function spawnWorker(dbPath: string): void {
  const workerPath = path.join(__dirname, 'dbWorker.js')
  const localWorker = new Worker(workerPath, {
    workerData: { dbPath, sessionBubblesLimit: SESSION_BUBBLES_LIMIT },
  })
  worker = localWorker

  localWorker.on(
    'message',
    (msg: {
      id: number
      result?: unknown
      error?: string
      type?: string
      level?: 'debug' | 'info' | 'warn' | 'error'
      msg?: string
    }) => {
      // Mirror the `'exit'` and `'error'` handlers' identity guard so a late
      // message from a worker we already replaced can't resolve/reject a
      // pending request belonging to the freshly-spawned worker.
      if (worker !== localWorker) {
        return
      }

      // Diagnostic messages from the worker (e.g. SQLITE_BUSY notices) are
      // routed through the main-thread logger to keep all observability in
      // one structured channel.
      if (msg.type === 'diagnostic') {
        const level = msg.level ?? 'warn'
        const text = msg.msg ?? '[dbWorker] (no message)'
        logger[level]({ source: 'dbWorker' }, text)
        return
      }

      // id: -1 is sent by the worker's unhandledRejection handler — log it
      // so the error isn't silently lost
      if (msg.id === -1 && msg.error) {
        logger.error(
          { error: msg.error },
          '[db.ts] Unhandled rejection in worker'
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
        pending.resolve(msg.result)
      }
    }
  )

  localWorker.on('error', (err: Error) => {
    // Mirror the `'exit'` handler's identity guard — see comment above.
    if (worker !== localWorker) {
      return
    }
    logger.error({ err }, '[db.ts] Worker error')
    for (const [id, pending] of pendingRequests) {
      pending.reject(new Error(`Worker error: ${err.message}`))
      pendingRequests.delete(id)
    }
  })

  localWorker.on('exit', (code) => {
    const isCurrentWorker = worker === localWorker
    if (isCurrentWorker) {
      worker = null
      for (const [id, pending] of pendingRequests) {
        pending.reject(new Error(`Worker exited with code ${code}`))
        pendingRequests.delete(id)
      }
    }

    if (code !== 0 && !isClosing && isCurrentWorker) {
      logger.warn(
        `[db.ts] Worker exited with code ${code}, will restart on next request`
      )
    }
  })
}

/**
 * Ensure the worker is running, restarting it if it crashed.
 * Protects against crash loops: max 3 restarts within 60s,
 * plus a separate ceiling on consecutive timeout-driven recycles.
 * Returns true if the worker is available.
 */
function ensureWorker(): boolean {
  if (worker) {
    return true
  }

  if (!storedDbPath || isClosing) {
    return false
  }

  if (timeoutRecycleSuppressed) {
    return false
  }

  // Crash-loop protection: prune old timestamps and check limit
  const now = Date.now()
  while (
    restartTimestamps.length > 0 &&
    now - restartTimestamps[0] > RESTART_WINDOW_MS
  ) {
    restartTimestamps.shift()
  }
  if (restartTimestamps.length >= MAX_RESTARTS) {
    logger.error(
      `[db.ts] Worker restart suppressed (${MAX_RESTARTS} restarts in ${RESTART_WINDOW_MS / 1000}s)`
    )
    return false
  }

  restartTimestamps.push(now)
  logger.info('[db.ts] Restarting DB worker after unexpected exit')
  spawnWorker(storedDbPath)
  return !!worker
}

/**
 * Forcibly terminate the current worker so the next request spawns a fresh
 * one. Used when a request times out — the worker thread is still blocked
 * on a synchronous DatabaseSync query, so queuing more requests on it just
 * piles up timeouts cycle after cycle (the T-445 failure mode).
 *
 * This is an *intentional* recycle, not a crash, so we clear the crash-loop
 * `restartTimestamps` to avoid permanently suppressing the worker for users
 * whose DB times out a few cycles in a row (exactly the scenario this
 * ticket is fixing). To still bound a *truly* broken DB that hangs every
 * cycle forever, we maintain a separate `consecutiveTimeoutRecycles`
 * counter that flips `timeoutRecycleSuppressed` after MAX_CONSECUTIVE.
 * The next successful response resets the counter (see message handler).
 */
function terminateStuckWorker(reason: string): void {
  if (!worker) {
    return
  }
  const stuck = worker
  worker = null
  restartTimestamps.length = 0

  consecutiveTimeoutRecycles += 1
  if (consecutiveTimeoutRecycles >= MAX_CONSECUTIVE_TIMEOUT_RECYCLES) {
    timeoutRecycleSuppressed = true
    logger.error(
      `[db.ts] DB worker disabled after ${MAX_CONSECUTIVE_TIMEOUT_RECYCLES} consecutive timeout recycles — likely corrupt or pathologically slow "state.vscdb"`
    )
    notifyUserSuppressed()
  } else {
    logger.warn(
      `[db.ts] Terminating stuck DB worker (${consecutiveTimeoutRecycles}/${MAX_CONSECUTIVE_TIMEOUT_RECYCLES}): ${reason}`
    )
  }

  // Reject any other requests queued on the stuck worker now, rather than
  // letting each one wait for its own timeout. The exit handler won't do
  // this for us (it bails via the isCurrentWorker guard so it can't
  // clobber a freshly-spawned replacement).
  for (const [id, pending] of pendingRequests) {
    pending.reject(new Error(`DB worker terminated: ${reason}`))
    pendingRequests.delete(id)
  }
  // Fire-and-forget: terminate() resolves once the thread is gone. The
  // caller has already rejected its own request on timeout.
  stuck.terminate().catch((err: Error) => {
    logger.warn({ err }, '[db.ts] Error terminating stuck worker')
  })
}

/**
 * Send a request to the worker and wait for the response.
 */
function workerRequest<T>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs: number = WORKER_REQUEST_TIMEOUT_MS
): Promise<T> {
  if (!ensureWorker()) {
    return Promise.reject(new Error('DB worker not initialized'))
  }

  const id = nextRequestId++
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      // Defensive: if the response already arrived (or another timeout
      // already terminated the worker and rejected this entry), do nothing.
      // The current poll loop is sequential so this is mainly future-proofing
      // against concurrent in-flight requests.
      if (!pendingRequests.has(id)) {
        return
      }
      pendingRequests.delete(id)
      // The worker thread is still blocked on the synchronous query —
      // kill it so the next poll cycle gets a fresh thread instead of
      // queuing on a stuck one. See T-445.
      terminateStuckWorker(`request ${method} exceeded ${timeoutMs}ms`)
      reject(new Error(`DB worker request timed out: ${method}`))
    }, timeoutMs)

    pendingRequests.set(id, {
      resolve: (value) => {
        clearTimeout(timeout)
        // A successful response means the worker is healthy; reset the
        // consecutive-timeout-recycle counter.
        consecutiveTimeoutRecycles = 0
        resolve(value as T)
      },
      reject: (err) => {
        clearTimeout(timeout)
        reject(err)
      },
    })

    worker!.postMessage({ id, method, params })
  })
}

/**
 * Show a one-time VS Code warning when the DB worker is disabled after the
 * timeout-recycle ceiling is hit. Without this, the extension silently
 * stops collecting Cursor data with no signal to the user.
 *
 * One-shot per process: subsequent suppression events would only happen
 * after an extension restart that resets the latch (see `initDB`), so
 * re-warning would just be noise.
 */
let didNotifySuppressed = false
function notifyUserSuppressed(): void {
  if (didNotifySuppressed) {
    return
  }
  didNotifySuppressed = true
  try {
    void vscode.window
      .showWarningMessage(
        'Mobb Tracy: paused Cursor session monitoring after repeated database timeouts. Reload the window to retry.',
        'Reload Window'
      )
      .then((choice) => {
        if (choice === 'Reload Window') {
          void vscode.commands.executeCommand('workbench.action.reloadWindow')
        }
      })
  } catch (err) {
    // Defensive: vscode.window may not be available in all execution contexts
    // (e.g. unit tests). Surface to the log and move on.
    logger.warn({ err }, '[db.ts] Failed to surface suppression warning')
  }
}

/**
 * Initialize the database module by creating a Worker thread.
 *
 * @param context - VS Code extension context used to locate the database
 */
export async function initDB(context: vscode.ExtensionContext): Promise<void> {
  if (worker) {
    return
  }

  const dbPath = getDatabasePath(context)

  // Verify the database file exists
  try {
    await fs.access(dbPath)
  } catch {
    throw new Error(`Database file not found: ${dbPath}`)
  }

  // Reset module-level lifecycle state so an extension reactivation (which
  // calls closeDB() then initDB() within the same host) can recover from a
  // previous session's suppression latch. Without this reset, a user who
  // hit MAX_CONSECUTIVE_TIMEOUT_RECYCLES would be stuck until a full host
  // reload — even after deactivating + reactivating the extension.
  consecutiveTimeoutRecycles = 0
  timeoutRecycleSuppressed = false
  restartTimestamps.length = 0
  didNotifySuppressed = false

  isClosing = false
  storedDbPath = dbPath
  spawnWorker(dbPath)

  logger.debug(
    `[db.ts] Database worker initialized: ${dbPath} (Node ${process.version})`
  )
}

/**
 * Close the database module by terminating the Worker.
 */
export async function closeDB(): Promise<void> {
  isClosing = true
  storedDbPath = null

  if (!worker) {
    return
  }

  try {
    await workerRequest('close')
  } catch {
    // Ignore errors during close — including a timeout, in which case
    // `terminateStuckWorker` has already terminated the worker and set
    // `worker = null`. The null-guard below covers that case.
  }

  if (worker) {
    await worker.terminate()
    worker = null
  }
  pendingRequests.clear()
  logger.debug('[db.ts] Database module closed')
}

/**
 * Resolves the absolute path to Cursor's SQLite database file (state.vscdb).
 */
function getDatabasePath(context: vscode.ExtensionContext): string {
  const globalStoragePath = context.globalStorageUri.fsPath
  const cursorGlobalStorage = path.join(globalStoragePath, '..', 'state.vscdb')
  return path.resolve(cursorGlobalStorage)
}

/**
 * Fetch recent bubble keys for session discovery.
 * Returns keys only (no value) — pure index scan, no JSON parsing.
 * Returns empty array if the worker is unavailable (graceful degradation).
 */
export async function getRecentBubbleKeys(limit: number): Promise<DBRow[]> {
  if (!worker && !ensureWorker()) {
    logger.warn(
      '[db.ts] Worker unavailable, returning [] for getRecentBubbleKeys'
    )
    return []
  }
  return workerRequest<DBRow[]>('getRecentBubbleKeys', { limit })
}

/**
 * Batch-fetch bubbles + composerData for multiple sessions in a single
 * worker round-trip. Single connection open/close = single lock acquisition.
 * Returns empty array if the worker is unavailable (graceful degradation).
 */
export async function prefetchSessions(
  sessions: SessionRequest[],
  bubblesLimit?: number
): Promise<SessionResult[]> {
  if (sessions.length === 0) {
    return []
  }
  if (!worker && !ensureWorker()) {
    logger.warn('[db.ts] Worker unavailable, returning [] for prefetchSessions')
    return []
  }
  return workerRequest<SessionResult[]>('prefetchSessions', {
    sessions,
    bubblesLimit,
  })
}
