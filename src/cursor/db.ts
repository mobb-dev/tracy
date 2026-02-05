/**
 * Database module for interacting with Cursor's SQLite database (state.vscdb).
 * This module provides read-only access to Cursor's internal key-value store.
 *
 * Uses Node.js 22+ built-in sqlite module (node:sqlite) for:
 * - Direct file queries (no memory copy like sql.js)
 * - Automatic WAL read support (no checkpoint needed)
 * - Persistent connection with reconnection on error
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import * as vscode from 'vscode'

import { logger } from '../shared/logger'

/** Cached database path */
let dbPath: string | null = null

/** Persistent database connection */
let db: DatabaseSync | null = null

/**
 * Get database connection, creating if needed.
 * Opens with readOnly to allow concurrent access while Cursor has the DB open.
 *
 * @returns DatabaseSync connection
 * @throws Error if dbPath not initialized
 */
function getConnection(): DatabaseSync {
  if (!dbPath) {
    throw new Error('DB not initialized')
  }

  if (!db) {
    db = new DatabaseSync(dbPath, { readOnly: true })
    logger.debug('[db.ts] Database connection established')
  }
  return db
}

/**
 * Close current connection (for reconnection on error).
 */
function closeConnection(): void {
  try {
    db?.close()
  } catch {
    // Ignore close errors
  }
  db = null
}

/**
 * Execute a query with automatic reconnection on error.
 * If the first attempt fails (e.g., stale connection), closes and retries once.
 *
 * @param fn - Function that executes the query
 * @returns Query result
 */
function executeWithReconnect<T>(fn: (conn: DatabaseSync) => T): T {
  try {
    return fn(getConnection())
  } catch (err) {
    logger.warn({ err }, '[db.ts] Query failed, reconnecting...')
    closeConnection()
    // Retry once with fresh connection
    return fn(getConnection())
  }
}

/**
 * Initialize the database module by storing the path and establishing connection.
 *
 * @param context - VS Code extension context used to locate the database
 */
export async function initDB(context: vscode.ExtensionContext): Promise<void> {
  if (dbPath && db) {
    return
  }

  dbPath = getDatabasePath(context)

  // Verify the database file exists
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database file not found: ${dbPath}`)
  }

  // Establish initial connection
  getConnection()

  logger.debug(
    `[db.ts] Database initialized: ${dbPath} (Node ${process.version})`
  )
}

/**
 * Close the database module.
 */
export async function closeDB(): Promise<void> {
  closeConnection()
  dbPath = null
  logger.debug('[db.ts] Database module closed')
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

  return executeWithReconnect((conn) => {
    const columns = keyOnly ? 'key' : 'key, value'
    let sql = `SELECT ${columns} FROM cursorDiskKV WHERE key LIKE ?`
    const params: string[] = [key]

    if (value) {
      sql += ' AND value LIKE ?'
      params.push(value)
    }

    const stmt = conn.prepare(sql)
    return stmt.all(...params) as DBRow[]
  })
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
  'edit_file_v2',
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
  return executeWithReconnect((conn) => {
    const placeholders = FILE_EDIT_TOOLS.map(() => '?').join(', ')

    const sql = `
      SELECT key, value FROM cursorDiskKV
      WHERE key LIKE 'bubbleId:%'
      AND json_extract(value, '$.toolFormerData.name') IN (${placeholders})
    `
      .replace(/\n/g, ' ')
      .trim()

    const stmt = conn.prepare(sql)
    return stmt.all(...FILE_EDIT_TOOLS) as DBRow[]
  })
}

/**
 * Get content stored at a composer.content.* key.
 * Used for edit_file_v2 which stores before/after content separately.
 *
 * @param contentId - The content ID (e.g., "composer.content.abc123...")
 * @returns The content string, or undefined if not found
 */
export async function getComposerContent(
  contentId: string
): Promise<string | undefined> {
  return executeWithReconnect((conn) => {
    const sql = 'SELECT value FROM cursorDiskKV WHERE key = ?'
    const stmt = conn.prepare(sql)
    const row = stmt.get(contentId) as { value?: string } | undefined
    return row?.value
  })
}
