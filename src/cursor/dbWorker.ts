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

const FILE_EDIT_TOOLS = [
  'search_replace',
  'apply_patch',
  'write',
  'edit_file',
  'edit_file_v2',
  'MultiEdit',
]

let db: InstanceType<typeof DatabaseSync> | null = null
const { dbPath } = workerData
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

function getCompletedFileEditBubblesSince(
  sinceIso: string,
  limit: number
): DBRow[] {
  return execute((conn) => {
    const placeholders = FILE_EDIT_TOOLS.map(() => '?').join(', ')
    const sql = `
      SELECT key, value FROM cursorDiskKV
      WHERE key LIKE 'bubbleId:%'
      AND json_extract(value, '$.toolFormerData.name') IN (${placeholders})
      AND json_extract(value, '$.createdAt') > ?
      ORDER BY json_extract(value, '$.createdAt') ASC
      LIMIT ?
    `
      .replace(/\n/g, ' ')
      .trim()

    const stmt = conn.prepare(sql)
    return stmt.all(...FILE_EDIT_TOOLS, sinceIso, limit) as DBRow[]
  })
}

const SQLITE_MAX_PARAMS = 500

function getBubblesByKeys(keys: string[]): DBRow[] {
  if (keys.length === 0) {
    return []
  }

  return execute((conn) => {
    const results: DBRow[] = []
    for (let i = 0; i < keys.length; i += SQLITE_MAX_PARAMS) {
      const chunk = keys.slice(i, i + SQLITE_MAX_PARAMS)
      const placeholders = chunk.map(() => '?').join(', ')
      const sql = `SELECT key, value FROM cursorDiskKV WHERE key IN (${placeholders})`
      const stmt = conn.prepare(sql)
      results.push(...(stmt.all(...chunk) as DBRow[]))
    }
    return results
  })
}

// Message handler
parentPort?.on('message', (msg: WorkerRequest) => {
  const { id, method, params } = msg
  let response: WorkerResponse

  // Check journal file before any query — if Cursor is mid-write, skip immediately
  if (
    method !== 'close' &&
    method !== 'releaseConnection' &&
    isCursorWriting()
  ) {
    parentPort?.postMessage({ id, error: 'database is locked' })
    return
  }

  try {
    let result: unknown

    switch (method) {
      case 'getCompletedFileEditBubblesSince':
        result = getCompletedFileEditBubblesSince(
          params.sinceIso as string,
          params.limit as number
        )
        break
      case 'getBubblesByKeys':
        result = getBubblesByKeys(params.keys as string[])
        break
      case 'releaseConnection':
        closeConnection()
        result = true
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
