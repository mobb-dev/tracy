/**
 * Worker thread for SQLite database queries.
 * Runs DatabaseSync operations off the extension host's main thread,
 * preventing Cursor freezes caused by long-running synchronous queries.
 */

import { parentPort, workerData } from 'node:worker_threads'

import type { DBRow, SessionRequest, SessionResult } from './types'

// node:sqlite is available in Node 22+
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require('node:sqlite')

type PreparedStatement = ReturnType<
  InstanceType<typeof DatabaseSync>['prepare']
>

type WorkerRequest = {
  id: number
  method: string
  params: Record<string, unknown>
}

type WorkerResponse = {
  id: number
  result?: unknown
  error?: string
  perf?: {
    queryDurationMs: number
    heapUsedBytes: number
    rssBytes: number
    rowsReturned: number
  }
}

/**
 * SQLite's default `SQLITE_MAX_VARIABLE_NUMBER` is 999. We reserve 2 slots
 * for `afterRowId` and `limit`, leaving up to 997 for `IN (...)` placeholders.
 * Queries with more keys than this are split into chunks and merged.
 *
 * Today the upstream `RECENT_DISCOVERY_LIMIT` is 500, so a single session
 * can have at most 500 discovered keys — we never actually chunk in
 * practice. The cap exists to fail safely if that constant is ever raised.
 */
const MAX_IN_PARAMS = 900

let db: InstanceType<typeof DatabaseSync> | null = null
const { dbPath, sessionBubblesLimit } = workerData

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
    // busy_timeout = 3000: let SQLite handle transient lock contention
    // internally (up to 3s) rather than failing immediately. Previously we
    // used 0 + a journal-file pre-check, but under heavy Cursor write load
    // the journal check became its own failure mode. 3s is well below the
    // 10s worker-request timeout, so we still fail fast on genuine hangs.
    db.exec('PRAGMA busy_timeout = 3000')
    // No cached prepared statements — the worker is recycled after every
    // poll cycle (to reset its V8 heap), so statements are never reused
    // across cycles. Caching them was misleading (PR review Finding 9).
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
 * Send a diagnostic message to the main thread's structured logger.
 * Used for events that aren't tied to a specific request (e.g. SQLite
 * contention notices) so all observability flows through `postMessage`
 * instead of the worker writing directly to stderr via `console`.
 *
 * `id: -2` distinguishes diagnostics from request responses (`id >= 0`)
 * and from unhandled-rejection notices (`id: -1`).
 */
function postDiagnostic(
  level: 'debug' | 'info' | 'warn' | 'error',
  msg: string
): void {
  try {
    parentPort?.postMessage({ id: -2, type: 'diagnostic', level, msg })
  } catch {
    // Last resort — if postMessage itself throws, drop the diagnostic.
  }
}

/**
 * Execute a query. Ensures the connection + cached statements are ready.
 * On failure, close the connection (invalidates cached statements too)
 * and re-throw. No retries — the poll loop handles that.
 *
 * Routes `SQLITE_BUSY` / "database is locked" errors back to the main
 * thread as a diagnostic so lock contention remains visible after the
 * removal of the `isCursorWriting()` pre-check (replaced by
 * `PRAGMA busy_timeout = 3000` in `getConnection`).
 */
function execute<T>(fn: (conn: InstanceType<typeof DatabaseSync>) => T): T {
  const conn = getConnection()
  try {
    return fn(conn)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('SQLITE_BUSY') || msg.includes('database is locked')) {
      postDiagnostic(
        'warn',
        `[dbWorker] SQLite contention after busy_timeout=3000ms: ${msg}`
      )
    }
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
    const stmt = conn.prepare(
      `SELECT key FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' ORDER BY rowid DESC LIMIT ?`
    )
    return stmt.all(limit) as DBRow[]
  })
}

/**
 * Escape LIKE wildcards (% and _) in a string so they are matched literally.
 */
function escapeLikeWildcards(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&')
}

/**
 * Get-or-create a prepared `IN (...)` statement keyed by placeholder count
 * and rowid-filter presence. Statements are reused within a single
 * `prefetchSessions` call (cleared when the connection closes) — avoids
 * re-compiling identical SQL when multiple sessions have the same
 * `discoveredKeys.length`.
 */
function getInClauseStmt(
  conn: InstanceType<typeof DatabaseSync>,
  placeholderCount: number,
  withRowIdFilter: boolean,
  cache: Map<string, PreparedStatement>
): PreparedStatement {
  const cacheKey = `${withRowIdFilter ? 'rowid' : 'norowid'}:${placeholderCount}`
  const existing = cache.get(cacheKey)
  if (existing) {
    return existing
  }
  const placeholders = new Array(placeholderCount).fill('?').join(',')
  const sql = withRowIdFilter
    ? `SELECT rowid, key, value FROM cursorDiskKV WHERE key IN (${placeholders}) AND rowid > ? ORDER BY rowid ASC LIMIT ?`
    : `SELECT rowid, key, value FROM cursorDiskKV WHERE key IN (${placeholders}) ORDER BY rowid ASC LIMIT ?`
  const stmt = conn.prepare(sql)
  cache.set(cacheKey, stmt)
  return stmt
}

/**
 * Run an IN(...) lookup against `discoveredKeys` that exceeds
 * `MAX_IN_PARAMS`, chunking into batches of `MAX_IN_PARAMS` to stay below
 * SQLite's `SQLITE_MAX_VARIABLE_NUMBER` (default 999).
 *
 * Defensive only — current upstream bound `RECENT_DISCOVERY_LIMIT = 500`
 * keeps us well under `MAX_IN_PARAMS`, so this path is unreachable today.
 *
 * Each chunk is queried with the same `LIMIT`; results are merged, sorted
 * by rowid, and sliced to the global limit. Note that with skewed
 * distributions an individual chunk can hit its LIMIT and drop rows that
 * would have been in the global top-N — acceptable because chunking only
 * activates if the upstream limit ever grows past 900.
 */
function fetchBubblesChunked(
  conn: InstanceType<typeof DatabaseSync>,
  discoveredKeys: string[],
  afterRowId: number | undefined,
  limit: number,
  inStmtCache: Map<string, PreparedStatement>
): DBRow[] {
  const withRowId = afterRowId != null
  const merged: DBRow[] = []
  for (let i = 0; i < discoveredKeys.length; i += MAX_IN_PARAMS) {
    const chunk = discoveredKeys.slice(i, i + MAX_IN_PARAMS)
    const stmt = getInClauseStmt(conn, chunk.length, withRowId, inStmtCache)
    const rows = withRowId
      ? (stmt.all(...chunk, afterRowId, limit) as DBRow[])
      : (stmt.all(...chunk, limit) as DBRow[])
    merged.push(...rows)
  }
  merged.sort((a, b) => (a.rowid ?? 0) - (b.rowid ?? 0))
  return merged.slice(0, limit)
}

/**
 * Fetch bubbles for a single session — dispatcher across three paths.
 *
 * Fast path (single chunk): when the caller has already discovered exact
 * bubble keys (via `getRecentBubbleKeys`), use a single `IN (...)`
 * lookup. Orders of magnitude faster than `LIKE` on multi-GB databases —
 * 200x in the T-445 stress repro. Used on every cycle including
 * first-run: per-session LIKE blows past the 10s worker timeout on large
 * DBs, leaving users with no persisted cursor stuck forever (the original
 * T-445 lockout).
 *
 * Fast path (chunked): same as above but split across multiple queries
 * when `discoveredKeys.length > MAX_IN_PARAMS`. Defensive — see
 * `fetchBubblesChunked`.
 *
 * Fallback: LIKE scan, only for sessions whose keys aren't in the
 * recent-discovery window (rare — pending-cursor sessions discovered from
 * configStore that have `afterRowId` set).
 */
function fetchBubbles(
  conn: InstanceType<typeof DatabaseSync>,
  args: {
    composerId: string
    afterRowId: number | undefined
    discoveredKeys: string[] | undefined
    limit: number
    inStmtCache: Map<string, PreparedStatement>
    bubbleStmtWithRowId: PreparedStatement
    bubbleStmtNoRowId: PreparedStatement
  }
): DBRow[] {
  const {
    composerId,
    afterRowId,
    discoveredKeys,
    limit,
    inStmtCache,
    bubbleStmtWithRowId,
    bubbleStmtNoRowId,
  } = args

  if (discoveredKeys && discoveredKeys.length > 0) {
    if (discoveredKeys.length > MAX_IN_PARAMS) {
      return fetchBubblesChunked(
        conn,
        discoveredKeys,
        afterRowId,
        limit,
        inStmtCache
      )
    }
    const withRowId = afterRowId != null
    const stmt = getInClauseStmt(
      conn,
      discoveredKeys.length,
      withRowId,
      inStmtCache
    )
    return withRowId
      ? (stmt.all(...discoveredKeys, afterRowId, limit) as DBRow[])
      : (stmt.all(...discoveredKeys, limit) as DBRow[])
  }

  const escapedId = escapeLikeWildcards(composerId)
  const pattern = `bubbleId:${escapedId}:%`
  return afterRowId != null
    ? (bubbleStmtWithRowId.all(pattern, afterRowId, limit) as DBRow[])
    : (bubbleStmtNoRowId.all(pattern, limit) as DBRow[])
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
    const inStmtCache = new Map<string, PreparedStatement>()

    return sessions.map(
      ({ composerId, afterRowId, incompleteBubbleKeys, discoveredKeys }) => {
        const bubbles = fetchBubbles(conn, {
          composerId,
          afterRowId,
          discoveredKeys,
          limit,
          inStmtCache,
          bubbleStmtWithRowId,
          bubbleStmtNoRowId,
        })

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
      }
    )
  })
}

// Message handler
parentPort?.on('message', (msg: WorkerRequest) => {
  const { id, method, params } = msg

  const queryStart = Date.now()
  let response: WorkerResponse

  try {
    let result: unknown
    let rowsReturned = 0

    switch (method) {
      case 'getRecentBubbleKeys': {
        const rows = getRecentBubbleKeys(params.limit as number)
        rowsReturned = rows.length
        result = rows
        break
      }
      case 'prefetchSessions': {
        const sessions = prefetchSessions(
          params.sessions as SessionRequest[],
          params.bubblesLimit as number | undefined
        )
        rowsReturned = sessions.reduce(
          (n, s) => n + s.bubbles.length + s.revisitedBubbles.length,
          0
        )
        result = sessions
        break
      }
      case 'close':
        closeConnection()
        result = true
        break
      default:
        throw new Error(`Unknown method: ${method}`)
    }

    const workerMem = process.memoryUsage()
    response = {
      id,
      result,
      perf: {
        queryDurationMs: Date.now() - queryStart,
        heapUsedBytes: workerMem.heapUsed,
        rssBytes: workerMem.rss,
        rowsReturned,
      },
    }
  } catch (err) {
    response = {
      id,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  // Connection stays open for the duration of the worker's lifetime.
  // The worker is recycled after each poll cycle by CursorMonitor,
  // which resets the V8 heap and all native SQLite memory.
  parentPort?.postMessage(response)
})
