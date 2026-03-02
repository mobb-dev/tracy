/**
 * Test helper to read .vscdb files using sqlite3 CLI.
 * This allows tests to use real database fixtures without loading native modules.
 */

import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

export type DBRow = {
  key: string
  value?: string
}

const fixturesPath = path.resolve(__dirname, '../files')

/**
 * File edit tool names (same as in db.ts)
 */
const FILE_EDIT_TOOLS = [
  'search_replace',
  'apply_patch',
  'write',
  'edit_file',
  'edit_file_v2',
  'MultiEdit',
]

/**
 * Copy a DB file from fixtures to use as state.vscdb
 */
export function copyDbFile(srcName: string, destName: string): void {
  const srcPath = path.join(fixturesPath, srcName)
  const destPath = path.join(fixturesPath, destName)
  fs.copyFileSync(srcPath, destPath)
}

/**
 * Get the path to the test database
 */
export function getTestDbPath(): string {
  return path.join(fixturesPath, 'state.vscdb')
}

/**
 * Read rows from test database using sqlite3 CLI.
 * Mirrors the getRowsByLike function from db.ts
 */
export function readRowsByLike({
  key,
  value,
  keyOnly = false,
}: {
  key: string
  value?: string
  keyOnly?: boolean
}): DBRow[] {
  const dbPath = getTestDbPath()

  if (!fs.existsSync(dbPath)) {
    return []
  }

  const columns = keyOnly ? 'key' : 'key, value'
  let sql = `SELECT ${columns} FROM cursorDiskKV WHERE key LIKE '${escapeSQL(key)}'`

  if (value) {
    sql += ` AND value LIKE '${escapeSQL(value)}'`
  }

  return executeQuery(dbPath, sql)
}

/**
 * Read file edit bubbles from test database using sqlite3 CLI.
 * Mirrors the getCompletedFileEditBubbles function from db.ts
 */
export function readCompletedFileEditBubbles(): DBRow[] {
  const dbPath = getTestDbPath()

  if (!fs.existsSync(dbPath)) {
    return []
  }

  const toolNamesIn = FILE_EDIT_TOOLS.map((t) => `'${t}'`).join(', ')

  const sql = `
    SELECT key, value FROM cursorDiskKV
    WHERE key LIKE 'bubbleId:%'
    AND json_extract(value, '$.toolFormerData.name') IN (${toolNamesIn})
  `
    .replace(/\n/g, ' ')
    .trim()

  return executeQuery(dbPath, sql)
}

/**
 * Read multiple bubble rows by exact keys using a single sqlite3 query.
 * Much faster than calling readRowsByLike per key (avoids N subprocess spawns).
 */
export function readBubblesByKeys(keys: string[]): DBRow[] {
  if (keys.length === 0) {
    return []
  }

  const dbPath = getTestDbPath()
  if (!fs.existsSync(dbPath)) {
    return []
  }

  const keysIn = keys.map((k) => `'${escapeSQL(k)}'`).join(', ')
  const sql = `SELECT key, value FROM cursorDiskKV WHERE key IN (${keysIn})`

  return executeQuery(dbPath, sql)
}

/**
 * Execute a SQL query using sqlite3 CLI
 */
function executeQuery(dbPath: string, sql: string): DBRow[] {
  try {
    const cmd = `sqlite3 -readonly -json "${dbPath}" "${sql}"`

    const output = execSync(cmd, {
      encoding: 'utf-8',
      maxBuffer: 100 * 1024 * 1024,
    })

    if (!output.trim()) {
      return []
    }

    return JSON.parse(output) as DBRow[]
  } catch {
    return []
  }
}

/**
 * Escape a string for use in SQL string literals (sqlite3 CLI).
 * Handles single quotes, backslashes, and null bytes.
 * Note: This is test-only code; the production dbWorker uses parameterized queries.
 */
function escapeSQL(str: string): string {
  return str.replace(/\0/g, '').replace(/'/g, "''")
}

/**
 * Clean up test database file
 */
export function cleanupTestDb(): void {
  const statePath = path.join(fixturesPath, 'state.vscdb')
  if (fs.existsSync(statePath)) {
    fs.unlinkSync(statePath)
  }
}
