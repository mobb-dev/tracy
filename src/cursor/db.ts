/**
 * Database module for interacting with Cursor's SQLite database (state.vscdb).
 * This module provides read-only access to Cursor's internal key-value store.
 *
 * Uses sql.js (WASM-based SQLite) for cross-platform compatibility.
 * WAL checkpoint is performed via node:sqlite (Node 22+ built-in) before each
 * read cycle to ensure we have access to the latest data.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import initSqlJs, { Database } from 'sql.js'
import * as vscode from 'vscode'

import { logger } from '../shared/logger'
import { checkpoint } from './checkpoint'

/** Cached database path */
let dbPath: string | null = null

/** Cached sql.js SQL module */
let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null

/**
 * Initialize the database module by storing the path and initializing sql.js.
 *
 * @param context - VS Code extension context used to locate the database
 */
export async function initDB(context: vscode.ExtensionContext): Promise<void> {
  if (dbPath && SQL) {
    return
  }

  dbPath = getDatabasePath(context)

  // Verify the database file exists
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database file not found: ${dbPath}`)
  }

  // Initialize sql.js WASM module
  SQL = await initSqlJs()

  logger.info(`[db.ts] Database initialized: ${dbPath}`)
}

/**
 * Close the database module.
 * With sql.js, there's no persistent connection to close, just clear cached state.
 */
export async function closeDB(): Promise<void> {
  dbPath = null
  // SQL module can be reused, no need to clear it
  logger.info('[db.ts] Database module closed')
}

/**
 * Resolves the absolute path to Cursor's SQLite database file (state.vscdb).
 *
 * The database is located in Cursor's global storage directory, one level up
 * from the extension's own global storage path.
 *
 * Path transformation:
 * - From: /path/to/Cursor/User/globalStorage/publisher.extension-name
 * - To:   /path/to/Cursor/User/globalStorage/state.vscdb
 *
 * @param context - VS Code extension context containing the global storage URI
 * @returns Absolute path to state.vscdb
 */
function getDatabasePath(context: vscode.ExtensionContext): string {
  const globalStoragePath = context.globalStorageUri.fsPath
  const cursorGlobalStorage = path.join(globalStoragePath, '..', 'state.vscdb')
  return path.resolve(cursorGlobalStorage)
}

/**
 * Load the database file into memory and return a sql.js Database instance.
 * Attempts a WAL checkpoint first to ensure latest data is available.
 * If checkpoint fails (e.g., database locked), proceeds with potentially stale data.
 *
 * @returns sql.js Database instance
 * @throws Error if database is not initialized or file cannot be read
 */
async function loadDatabase(): Promise<Database> {
  if (!dbPath || !SQL) {
    throw new Error('DB not initialized')
  }

  // Attempt WAL checkpoint to flush pending transactions to main DB file
  // If this fails (e.g., Cursor holds the lock), we proceed with potentially stale data
  // The next poll cycle will try again
  checkpoint(dbPath)

  // Read the database file into memory (async to avoid blocking)
  const buffer = await fs.promises.readFile(dbPath)
  return new SQL.Database(buffer)
}

/**
 * Represents a row from the cursorDiskKV table in Cursor's database.
 * The database uses a simple key-value structure for storing state.
 */
export type DBRow = {
  /** The key identifier for the stored value */
  key: string
  /** The stored value (optional when keyOnly is true) */
  value?: string
}

/**
 * Query the SQLite database with LIKE pattern matching.
 *
 * Performs a WAL checkpoint before reading to ensure latest data is available.
 *
 * @param params - Query parameters
 * @param params.key - Key pattern to match (supports SQL LIKE wildcards: % and _)
 * @param params.value - Optional value pattern to match (supports SQL LIKE wildcards)
 * @param params.keyOnly - If true, only return keys without values for better performance
 * @returns Array of matching database rows
 * @throws Error if key is empty, DB is not initialized, or query execution fails
 *
 * @example
 * // Find all keys starting with "user."
 * const rows = await getRowsByLike({ key: 'user.%' })
 *
 * @example
 * // Find keys matching pattern with specific value
 * const rows = await getRowsByLike({ key: 'settings.%', value: '%dark%' })
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

  const db = await loadDatabase()

  try {
    const columns = keyOnly ? 'key' : 'key, value'
    let sql = `SELECT ${columns} FROM cursorDiskKV WHERE key LIKE $key`
    const params: Record<string, string> = { $key: key }

    if (value) {
      sql += ' AND value LIKE $value'
      params.$value = value
    }

    const stmt = db.prepare(sql)
    stmt.bind(params)

    const rows: DBRow[] = []
    while (stmt.step()) {
      const row = stmt.getAsObject() as DBRow
      rows.push(row)
    }
    stmt.free()

    return rows
  } catch (err) {
    logger.error({ err, key, value }, '[db.ts] getRowsByLike query failed')
    throw err
  } finally {
    db.close()
  }
}

/**
 * File edit tool names in Cursor that we want to track.
 * These are the tools that modify files and have codeblockId when completed.
 */
const FILE_EDIT_TOOLS = [
  'search_replace',
  'apply_patch',
  'write',
  'edit_file',
  'MultiEdit',
]

/**
 * Query for bubble rows that are file edit tool calls.
 *
 * This is an optimized query that filters at the SQL level using JSON extraction,
 * significantly reducing the number of rows that need to be parsed in JavaScript.
 *
 * Filters by tool name (more reliable than codeblockId which is set async):
 * - search_replace, apply_patch, write, edit_file, MultiEdit
 *
 * Note: codeblockId is checked in processor.ts after fetching, as it may be set
 * slightly after status becomes 'completed'.
 *
 * @returns Array of bubble rows for file edit tools
 */
export async function getCompletedFileEditBubbles(): Promise<DBRow[]> {
  const db = await loadDatabase()

  try {
    const placeholders = FILE_EDIT_TOOLS.map(() => '?').join(', ')

    const sql = `
      SELECT key, value FROM cursorDiskKV
      WHERE key LIKE 'bubbleId:%'
      AND json_extract(value, '$.toolFormerData.name') IN (${placeholders})
    `
      .replace(/\n/g, ' ')
      .trim()

    const stmt = db.prepare(sql)
    stmt.bind(FILE_EDIT_TOOLS)

    const rows: DBRow[] = []
    while (stmt.step()) {
      const row = stmt.getAsObject() as DBRow
      rows.push(row)
    }
    stmt.free()

    return rows
  } catch (err) {
    logger.error({ err }, '[db.ts] getCompletedFileEditBubbles query failed')
    throw err
  } finally {
    db.close()
  }
}
