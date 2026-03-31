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

/** Monotonic request ID counter */
let nextRequestId = 0

/** Pending request callbacks */
const pendingRequests = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>()

/**
 * Spawn a new worker thread and wire up event handlers.
 */
function spawnWorker(dbPath: string): void {
  const workerPath = path.join(__dirname, 'dbWorker.js')
  worker = new Worker(workerPath, {
    workerData: { dbPath, sessionBubblesLimit: SESSION_BUBBLES_LIMIT },
  })

  worker.on(
    'message',
    (msg: { id: number; result?: unknown; error?: string }) => {
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

  worker.on('error', (err: Error) => {
    logger.error({ err }, '[db.ts] Worker error')
    // Reject all pending requests
    for (const [id, pending] of pendingRequests) {
      pending.reject(new Error(`Worker error: ${err.message}`))
      pendingRequests.delete(id)
    }
  })

  worker.on('exit', (code) => {
    worker = null
    // Reject all pending requests
    for (const [id, pending] of pendingRequests) {
      pending.reject(new Error(`Worker exited with code ${code}`))
      pendingRequests.delete(id)
    }

    if (code !== 0 && !isClosing) {
      logger.warn(
        `[db.ts] Worker exited with code ${code}, will restart on next request`
      )
    }
  })
}

/**
 * Ensure the worker is running, restarting it if it crashed.
 * Protects against crash loops: max 3 restarts within 60s.
 * Returns true if the worker is available.
 */
function ensureWorker(): boolean {
  if (worker) {
    return true
  }

  if (!storedDbPath || isClosing) {
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
      pendingRequests.delete(id)
      reject(new Error(`DB worker request timed out: ${method}`))
    }, timeoutMs)

    pendingRequests.set(id, {
      resolve: (value) => {
        clearTimeout(timeout)
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
    // Ignore errors during close
  }

  await worker.terminate()
  worker = null
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
 * Represents a row from the cursorDiskKV table in Cursor's database.
 */
export type DBRow = {
  rowid?: number
  key: string
  value?: string
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

type SessionRequest = {
  composerId: string
  afterRowId?: number
  incompleteBubbleKeys?: string[]
}

type SessionResult = {
  composerId: string
  bubbles: DBRow[]
  composerDataValue: string | undefined
  revisitedBubbles: DBRow[]
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
