/**
 * Worker thread for SQLite database queries.
 * Runs DatabaseSync operations off the extension host's main thread,
 * preventing Cursor freezes caused by long-running synchronous queries.
 */

import * as fs from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'

// node:sqlite is available in Node 22+
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require('node:sqlite')

type DBRow = {
  rowid?: number
  key: string
  value?: string
}

type WorkerRequest = {
  id: number
  method: string
  params: Record<string, unknown>
}

type WorkerResponse = {
  id: number
  result?: unknown
  error?: string
}

let db: InstanceType<typeof DatabaseSync> | null = null
const { dbPath, sessionBubblesLimit } = workerData
const journalPath = `${dbPath}-journal`

// Safety net: catch unexpected promise rejections so the worker never crashes silently
process.on('unhandledRejection', (reason) => {
  try {
    parentPort?.postMessage({
      id: -1,
      error: `Unhandled rejection in DB worker: ${reason}`,
    })
  } catch {
    // Last resort — nothing we can do
  }
})

function getConnection(): InstanceType<typeof DatabaseSync> {
  if (!db) {
    db = new DatabaseSync(dbPath, { readOnly: true })
    // busy_timeout = 0: fail instantly if the DB is locked.
    // Cursor's database is Cursor's — we are guests and must never block its writes.
    // The poll loop retries in ~20 seconds anyway.
    db.exec('PRAGMA busy_timeout = 0')
  }
  return db
}

function closeConnection(): void {
  try {
    db?.close()
  } catch {
    // Ignore close errors
  }
  db = null
}

/**
 * Check if Cursor is mid-write transaction by looking for the journal file.
 * If the journal exists, we skip the query entirely to give Cursor absolute
 * write precedence.
 */
function isCursorWriting(): boolean {
  try {
    return fs.existsSync(journalPath)
  } catch {
    return false
  }
}

/**
 * Execute a query. On failure, close the connection (releasing any SHARED
 * locks) and re-throw. No retries — the poll loop handles that.
 */
function execute<T>(fn: (conn: InstanceType<typeof DatabaseSync>) => T): T {
  try {
    return fn(getConnection())
  } catch (err) {
    closeConnection()
    throw err
  }
}

// Safety fallback — must match SESSION_BUBBLES_LIMIT in rawProcessor.ts.
// In normal flow, bubblesLimit is always passed explicitly by CursorMonitor.
const DEFAULT_BUBBLES_LIMIT: number = sessionBubblesLimit ?? 50

/**
 * Fetch the most recent bubble keys for session discovery.
 * Returns keys only (no value) — avoids JSON parsing in SQL entirely.
 * The key column is indexed, so this is a pure B-tree range scan.
 * We fetch the last N keys by rowid DESC as a proxy for recency
 * (Cursor appends rows chronologically).
 */
function getRecentBubbleKeys(limit: number): DBRow[] {
  return execute((conn) => {
    const sql = `SELECT key FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' ORDER BY rowid DESC LIMIT ?`
    const stmt = conn.prepare(sql)
    return stmt.all(limit) as DBRow[]
  })
}

/**
 * Escape LIKE wildcards (% and _) in a string so they are matched literally.
 */
function escapeLikeWildcards(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&')
}

type SessionRequest = {
  composerId: string
  afterRowId?: number
  /** Exact keys of previously-incomplete bubbles to re-check. */
  incompleteBubbleKeys?: string[]
}

type SessionResult = {
  composerId: string
  bubbles: DBRow[]
  composerDataValue: string | undefined
  /** Re-fetched incomplete bubbles (by exact key). */
  revisitedBubbles: DBRow[]
}

/**
 * Batch-fetch bubbles + composerData for multiple sessions in a single
 * connection open/close cycle. Reduces lock acquisition from 2×N to 1.
 * Uses rowid for filtering — pure B-tree scan, no JSON parsing in SQL.
 * Also re-fetches incomplete bubbles by exact key to check if they've completed.
 */
function prefetchSessions(
  sessions: SessionRequest[],
  bubblesLimit?: number
): SessionResult[] {
  const limit = bubblesLimit ?? DEFAULT_BUBBLES_LIMIT
  return execute((conn) => {
    const bubbleStmtWithRowId = conn.prepare(
      `SELECT rowid, key, value FROM cursorDiskKV WHERE key LIKE ? ESCAPE '\\' AND rowid > ? ORDER BY rowid ASC LIMIT ?`
    )
    const bubbleStmtNoRowId = conn.prepare(
      `SELECT rowid, key, value FROM cursorDiskKV WHERE key LIKE ? ESCAPE '\\' ORDER BY rowid ASC LIMIT ?`
    )
    const composerStmt = conn.prepare(
      'SELECT value FROM cursorDiskKV WHERE key = ?'
    )
    const exactKeyStmt = conn.prepare(
      'SELECT rowid, key, value FROM cursorDiskKV WHERE key = ?'
    )

    return sessions.map(({ composerId, afterRowId, incompleteBubbleKeys }) => {
      const escapedId = escapeLikeWildcards(composerId)
      const pattern = `bubbleId:${escapedId}:%`

      const bubbles =
        afterRowId != null
          ? (bubbleStmtWithRowId.all(pattern, afterRowId, limit) as DBRow[])
          : (bubbleStmtNoRowId.all(pattern, limit) as DBRow[])

      const row = composerStmt.get(`composerData:${composerId}`) as
        | { value?: string }
        | undefined

      // Re-fetch incomplete bubbles by exact key (O(1) each)
      const revisitedBubbles: DBRow[] = []
      if (incompleteBubbleKeys) {
        for (const key of incompleteBubbleKeys) {
          const result = exactKeyStmt.get(key) as DBRow | undefined
          if (result) {
            revisitedBubbles.push(result)
          }
        }
      }

      return {
        composerId,
        bubbles,
        composerDataValue: row?.value,
        revisitedBubbles,
      }
    })
  })
}

// Message handler
parentPort?.on('message', (msg: WorkerRequest) => {
  const { id, method, params } = msg
  let response: WorkerResponse

  // Check journal file before any query — if Cursor is mid-write, skip immediately
  if (method !== 'close' && isCursorWriting()) {
    parentPort?.postMessage({ id, error: 'database is locked' })
    return
  }

  try {
    let result: unknown

    switch (method) {
      case 'getRecentBubbleKeys':
        result = getRecentBubbleKeys(params.limit as number)
        break
      case 'prefetchSessions':
        result = prefetchSessions(
          params.sessions as SessionRequest[],
          params.bubblesLimit as number | undefined
        )
        break
      case 'close':
        closeConnection()
        result = true
        break
      default:
        throw new Error(`Unknown method: ${method}`)
    }

    response = { id, result }
  } catch (err) {
    response = {
      id,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  // Close connection after every request to release SHARED locks immediately.
  // Re-opening is ~1ms — negligible vs the 20-second poll interval.
  closeConnection()

  parentPort?.postMessage(response)
})
