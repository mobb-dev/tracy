import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'

import { logger } from './logger'

let basePath: string | undefined

export function initFileLogger(ctx: vscode.ExtensionContext) {
  basePath = ctx.globalStorageUri.fsPath
  vscode.workspace.fs.createDirectory(vscode.Uri.file(basePath))
  logger.info({ basePath }, 'Logfile dir created')
}

/**
 * Writes a JSON object to a file in the given directory, resolving the path safely under basePath/eventsDir.
 * Ensures the directory exists and handles platform differences.
 * @param obj The object to write
 * @param id The event id
 * @param dir Optional nested dir (e.g. 'events')
 * @param nameHint Optional name hint for the file
 */
export async function logJsonToFile(
  obj: unknown,
  id: string,
  dir?: string,
  nameHint?: string
) {
  try {
    if (!basePath) {
      throw new Error(
        'File logger not initialized: call initFileLogger(ctx) first'
      )
    }
    let resolvePath = basePath
    if (dir) {
      resolvePath = path.resolve(basePath, dir)
      // Wait for directory creation to complete before proceeding
      await ensureDir(resolvePath)
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const safeHint = nameHint
      ? String(nameHint).replace(/[^a-zA-Z0-9._-]/g, '_')
      : undefined
    const safeId = String(id).replace(/[^a-zA-Z0-9._-]/g, '_')
    const filename = safeHint
      ? `${ts}-${safeId}-${safeHint}.json`
      : `${ts}-${safeId}.json`
    const filePath = path.resolve(resolvePath, filename)
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2))
  } catch (err) {
    logger.error({ err }, 'Failed to write event')
  }
}

// Ensure events dir exists
const ensureDir = async (dir: string) => {
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir))
}
