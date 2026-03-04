import * as path from 'node:path'

import * as vscode from 'vscode'

import { logger } from '../shared/logger'
import type { ToolCall } from './events/ToolCall'

type SnapshotEntry = {
  id?: string
  attachmentId?: string
  timeMs: number
  filePath: string
  baselineContent: string
}

// Size cap to prevent unbounded memory growth (same LRU pattern as GitBlameCache)
const MAX_SNAPSHOTS = 500

export class SnapshotTracker {
  /** filePath -> most recent snapshot (read or attachment) */
  private snapshots = new Map<string, SnapshotEntry>()

  /** Normalize a file path to absolute using the correct workspace folder. */
  private resolveToAbsolutePath(filePath: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath
    }

    // Resolve relative path against the first workspace folder,
    // with path traversal protection to prevent escaping the workspace.
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (wsFolder) {
      const resolved = path.resolve(wsFolder, filePath)
      if (!resolved.startsWith(wsFolder + path.sep) && resolved !== wsFolder) {
        logger.warn(
          `Path traversal blocked: ${filePath} resolved outside workspace`
        )
        return wsFolder
      }
      return resolved
    }
    return filePath // fallback: return as-is
  }

  /** Evict oldest entries if snapshots Map exceeds MAX_SNAPSHOTS */
  private evictIfNeeded(): void {
    while (this.snapshots.size >= MAX_SNAPSHOTS) {
      const oldestKey = this.snapshots.keys().next().value
      if (oldestKey) {
        this.snapshots.delete(oldestKey)
      }
    }
  }

  async onReadFile(evt: ToolCall): Promise<void> {
    if (!evt?.filePath) {
      return
    }
    const absPath = this.resolveToAbsolutePath(evt.filePath)
    const now = evt.time?.getTime?.() ?? Date.now()
    const baselineContent = await this.readCurrentFileText(absPath)
    const prev = this.snapshots.get(absPath)
    if (!prev || now > prev.timeMs) {
      this.evictIfNeeded()
      this.snapshots.set(absPath, {
        id: evt.id,
        timeMs: now,
        filePath: absPath,
        baselineContent,
      })
      logger.debug(`SnapshotTracker: set read marker for ${absPath}`)
    } else {
      logger.debug(`SnapshotTracker: skipped older read marker for ${absPath}`)
    }
  }

  /** Add an attachment snapshot to the tracker */
  async addAttachmentSnapshot(
    attachmentId: string,
    filePath: string,
    timeMs: number
  ): Promise<void> {
    const absPath = this.resolveToAbsolutePath(filePath)
    const baselineContent = await this.readCurrentFileText(absPath)
    const prev = this.snapshots.get(absPath)
    // If previous exists and attachmentId matches, skip
    if (prev && prev.attachmentId === attachmentId) {
      logger.debug(
        `SnapshotTracker: skipped duplicate attachment snapshot for ${absPath}`
      )
      return
    }
    // Otherwise, only update if no prev or this is newer
    if (!prev || timeMs > prev.timeMs) {
      this.evictIfNeeded()
      this.snapshots.set(absPath, {
        attachmentId,
        timeMs,
        filePath: absPath,
        baselineContent,
      })
      logger.debug(`SnapshotTracker: set attachment snapshot for ${absPath}`)
    } else {
      logger.debug(
        `SnapshotTracker: skipped older attachment snapshot for ${absPath}`
      )
    }
  }

  async getSnapshot(
    filePath: string,
    timeMs: number
  ): Promise<string | undefined> {
    const absPath = this.resolveToAbsolutePath(filePath)
    const snap = this.snapshots.get(absPath)
    if (snap && timeMs > snap.timeMs) {
      return snap.baselineContent
    }
    logger.debug(`[getSnapshot] No snapshot found for file: ${absPath}`)
    return undefined
  }

  /* ------------------------ internals ------------------------ */

  private async readCurrentFileText(filePath: string): Promise<string> {
    // Prefer in-memory doc (unsaved edits included)
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.fsPath === filePath
    )
    if (doc) {
      return doc.getText()
    }
    try {
      const uri = vscode.Uri.file(filePath)
      const bytes = await vscode.workspace.fs.readFile(uri)
      return Buffer.from(bytes).toString('utf8')
    } catch {
      return ''
    }
  }
}
