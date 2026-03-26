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
 * Read all recent bubbles from test database.
 * Mirrors getRecentBubbles from db.ts (returns all bubbles — window filtering
 * is not meaningful in tests since fixture timestamps are fixed).
 */
export function readRecentBubbles(): DBRow[] {
  const dbPath = getTestDbPath()
  if (!fs.existsSync(dbPath)) {
    return []
  }

  const sql = `SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' ORDER BY json_extract(value, '$.createdAt') ASC`
  return executeQuery(dbPath, sql)
}

/**
 * Read all bubbles for a given composerId.
 * Mirrors getSessionBubbles from db.ts.
 */
export function readSessionBubbles(composerId: string): DBRow[] {
  const dbPath = getTestDbPath()
  if (!fs.existsSync(dbPath)) {
    return []
  }

  const sql = `SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:${escapeSQL(composerId)}:%' ORDER BY json_extract(value, '$.createdAt') ASC`
  return executeQuery(dbPath, sql)
}

/**
 * Read composerData value for a given composerId.
 * Mirrors getComposerDataValue from db.ts.
 */
export function readComposerDataValue(composerId: string): string | undefined {
  const dbPath = getTestDbPath()
  if (!fs.existsSync(dbPath)) {
    return undefined
  }

  const sql = `SELECT value FROM cursorDiskKV WHERE key = 'composerData:${escapeSQL(composerId)}'`
  const rows = executeQuery(dbPath, sql)
  return rows[0]?.value
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
