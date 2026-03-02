/**
 * Worker thread for SQLite database queries.
 * Runs DatabaseSync operations off the extension host's main thread,
 * preventing Cursor freezes caused by long-running synchronous queries.
 */

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

function getConnection(): InstanceType<typeof DatabaseSync> {
  if (!db) {
    db = new DatabaseSync(dbPath, { readOnly: true })
    // Retry on lock contention instead of failing immediately with SQLITE_BUSY.
    // In delete journal mode, our reads acquire SHARED locks that block Cursor's writes.
    // busy_timeout lets SQLite retry internally for up to 3 seconds.
    db.exec('PRAGMA busy_timeout = 3000')
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

function executeWithReconnect<T>(
  fn: (conn: InstanceType<typeof DatabaseSync>) => T
): T {
  try {
    return fn(getConnection())
  } catch (err) {
    closeConnection()
    return fn(getConnection())
  }
}

function getCompletedFileEditBubblesSince(
  sinceIso: string,
  limit: number
): DBRow[] {
  return executeWithReconnect((conn) => {
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

function getRowsByLike(params: {
  key: string
  value?: string
  keyOnly?: boolean
}): DBRow[] {
  const { key, value, keyOnly = false } = params
  if (!key) {
    throw new Error('key cannot be null')
  }

  return executeWithReconnect((conn) => {
    const columns = keyOnly ? 'key' : 'key, value'
    let sql = `SELECT ${columns} FROM cursorDiskKV WHERE key LIKE ?`
    const sqlParams: string[] = [key]

    if (value) {
      sql += ' AND value LIKE ?'
      sqlParams.push(value)
    }

    const stmt = conn.prepare(sql)
    return stmt.all(...sqlParams) as DBRow[]
  })
}

function getComposerContent(contentId: string): string | undefined {
  return executeWithReconnect((conn) => {
    const sql = 'SELECT value FROM cursorDiskKV WHERE key = ?'
    const stmt = conn.prepare(sql)
    const row = stmt.get(contentId) as { value?: string } | undefined
    return row?.value
  })
}

const SQLITE_MAX_PARAMS = 500

function getBubblesByKeys(keys: string[]): DBRow[] {
  if (keys.length === 0) {
    return []
  }

  return executeWithReconnect((conn) => {
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

  try {
    let result: unknown

    switch (method) {
      case 'getCompletedFileEditBubblesSince':
        result = getCompletedFileEditBubblesSince(
          params.sinceIso as string,
          params.limit as number
        )
        break
      case 'getRowsByLike':
        result = getRowsByLike(
          params as { key: string; value?: string; keyOnly?: boolean }
        )
        break
      case 'getComposerContent':
        result = getComposerContent(params.contentId as string)
        break
      case 'getBubblesByKeys':
        result = getBubblesByKeys(params.keys as string[])
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

  parentPort?.postMessage(response)
})
