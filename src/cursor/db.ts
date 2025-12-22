import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import initSqlJs from 'sql.js'
import * as vscode from 'vscode'

import { logger } from '../shared/logger'

let adapter: initSqlJs.SqlJsStatic | null = null
let dbPath: string | null = null

export async function initDB(context: vscode.ExtensionContext) {
  logger.info('Initializing DB')
  if (!adapter || !dbPath) {
    adapter = await initSqlJs()
    dbPath = getDatabasePath(context)
  }
}

async function getDB() {
  if (!adapter || !dbPath) {
    throw new Error('DB not initialized')
  }
  const buffer = await fs.readFile(dbPath)
  return new adapter.Database(buffer)
}

function getDatabasePath(context: vscode.ExtensionContext): string {
  const globalStoragePath = context.globalStorageUri.fsPath

  // Navigate up to Cursor's User/globalStorage directory
  // From: /path/to/Cursor/User/globalStorage/publisher.extension-name
  // To:   /path/to/Cursor/User/globalStorage/state.vscdb
  const cursorGlobalStorage = path.join(globalStoragePath, '..', 'state.vscdb')

  return path.resolve(cursorGlobalStorage)
}

export type DBRow = {
  key: string
  value?: string
}

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

  const db = await getDB()
  let query = `SELECT key${keyOnly ? '' : ', value'} FROM cursorDiskKV WHERE key LIKE :key`

  if (value) {
    query += ' AND value LIKE :value'
  }

  const stmt = db.prepare(query)
  const rows: DBRow[] = []

  if (value) {
    stmt.bind({ ':value': value, ':key': key })
  } else {
    stmt.bind({ ':key': key })
  }

  while (stmt.step()) {
    const row = stmt.getAsObject() as unknown as DBRow

    rows.push(row)
  }

  stmt.free()
  db.close()

  return rows
}
