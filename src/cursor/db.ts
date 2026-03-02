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

import { logError } from '../shared/circularLog'
import { logger } from '../shared/logger'

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
    workerData: { dbPath },
  })

  worker.on(
    'message',
    (msg: { id: number; result?: unknown; error?: string }) => {
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
    logError('DB worker error', err.message)
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
  logError('DB worker restart', 'auto-restarting after crash')
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
  key: string
  value?: string
}

/**
 * Query the SQLite database with LIKE pattern matching.
 */
export async function getRowsByLike({
  key,
  value,
  keyOnly = false,
}: {
  key: string
  value?: string
  keyOnly?: boolean
}): Promise<DBRow[]> {
  if (!key) {
    throw new Error('key cannot be null')
  }

  return workerRequest<DBRow[]>('getRowsByLike', { key, value, keyOnly })
}

/**
 * Query for bubble rows created after a given timestamp.
 * Used for incremental polling — only fetches new rows.
 */
export async function getCompletedFileEditBubblesSince(
  sinceIso: string,
  limit: number
): Promise<DBRow[]> {
  return workerRequest<DBRow[]>('getCompletedFileEditBubblesSince', {
    sinceIso,
    limit,
  })
}

/**
 * Get content stored at a composer.content.* key.
 */
export async function getComposerContent(
  contentId: string
): Promise<string | undefined> {
  return workerRequest<string | undefined>('getComposerContent', { contentId })
}

/**
 * Batch fetch bubble rows by exact keys.
 * Replaces N individual getRowsByLike calls in extractConversation.
 */
export async function getBubblesByKeys(keys: string[]): Promise<DBRow[]> {
  if (keys.length === 0) {
    return []
  }

  return workerRequest<DBRow[]>('getBubblesByKeys', { keys })
}
