/**
 * Database module for interacting with Cursor's SQLite database (state.vscdb).
 * This module provides read-only access to Cursor's internal key-value store.
 *
 * Uses @vscode/sqlite3 which properly handles WAL (Write-Ahead Logging) mode,
 * unlike sql.js which reads the database file directly and misses uncommitted changes.
 */

import * as path from 'node:path'

import sqlite3 from '@vscode/sqlite3'
import * as vscode from 'vscode'

import { logger } from '../shared/logger'

/** Cached database instance */
let db: sqlite3.Database | null = null

/**
 * Initialize the database connection by opening Cursor's state.vscdb in read-only mode.
 *
 * @param context - VS Code extension context used to locate the database
 */
export async function initDB(context: vscode.ExtensionContext): Promise<void> {
  if (db) {
    return
  }

  const dbPath = getDatabasePath(context)

  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(
      dbPath,
      sqlite3.OPEN_READONLY,
      (err: Error | null) => {
        if (err) {
          logger.error(
            { err, dbPath },
            '[db.ts] Failed to open SQLite database'
          )
          reject(err)
        } else {
          logger.info(`[db.ts] Database opened: ${dbPath}`)
          resolve()
        }
      }
    )
  })
}

/**
 * Close the database connection.
 */
export async function closeDB(): Promise<void> {
  if (!db) {
    return
  }

  return new Promise((resolve, reject) => {
    db!.close((err: Error | null) => {
      if (err) {
        logger.error({ err }, '[db.ts] Error closing database')
        reject(err)
      } else {
        db = null
        resolve()
      }
    })
  })
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
 * Uses @vscode/sqlite3 which properly handles WAL (Write-Ahead Logging) mode,
 * ensuring we can read uncommitted transactions.
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

  if (!db) {
    throw new Error('DB not initialized')
  }

  const columns = keyOnly ? 'key' : 'key, value'
  let sql = `SELECT ${columns} FROM cursorDiskKV WHERE key LIKE ?`
  const params: string[] = [key]

  if (value) {
    sql += ' AND value LIKE ?'
    params.push(value)
  }

  return new Promise((resolve, reject) => {
    db!.all(sql, params, (err: Error | null, rows: DBRow[]) => {
      if (err) {
        logger.error({ err, sql, params }, '[db.ts] getRowsByLike query failed')
        reject(err)
      } else {
        resolve(rows || [])
      }
    })
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
  if (!db) {
    throw new Error('DB not initialized')
  }

  const placeholders = FILE_EDIT_TOOLS.map(() => '?').join(', ')

  const sql = `
    SELECT key, value FROM cursorDiskKV
    WHERE key LIKE 'bubbleId:%'
    AND json_extract(value, '$.toolFormerData.name') IN (${placeholders})
  `
    .replace(/\n/g, ' ')
    .trim()

  return new Promise((resolve, reject) => {
    db!.all(sql, FILE_EDIT_TOOLS, (err: Error | null, rows: DBRow[]) => {
      if (err) {
        logger.error(
          { err },
          '[db.ts] getCompletedFileEditBubbles query failed'
        )
        reject(err)
      } else {
        resolve(rows || [])
      }
    })
  })
}
