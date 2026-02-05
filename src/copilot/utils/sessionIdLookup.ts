import { setTimeout } from 'node:timers/promises'

import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'

import { logger } from '../../shared/logger'

/**
 * On-demand lookup of sessionId from VS Code chat session files.
 * Searches for tool call IDs in recently modified session files.
 *
 * This approach avoids unreliable file system watching by doing
 * targeted lookups only when needed (once per inference).
 */
export class SessionIdLookup {
  /** Only search files modified in the last 5 minutes */
  private static readonly RECENT_THRESHOLD_MS = 5 * 60 * 1000

  /** Maximum total time to wait for sessionId (2 minutes)
   * VS Code writes session files lazily, often 1-2 minutes after tool calls */
  private static readonly MAX_WAIT_MS = 120000
  /** Initial backoff delay */
  private static readonly INITIAL_BACKOFF_MS = 100

  private readonly workspaceStoragePath: string | undefined

  constructor(context: vscode.ExtensionContext) {
    this.workspaceStoragePath = this.deriveWorkspaceStoragePath(context)
  }

  /**
   * Derive the workspaceStorage path from VS Code's globalStorageUri.
   *
   * Path transformation:
   * - From: ~/...Code/User/globalStorage/{extension-id}
   * - To:   ~/...Code/User/workspaceStorage
   *
   * This approach works across all platforms and VS Code variants
   * (Code, Code Insiders, Cursor, remote development, etc.)
   */
  private deriveWorkspaceStoragePath(
    context: vscode.ExtensionContext
  ): string | undefined {
    try {
      const globalStoragePath = context.globalStorageUri.fsPath
      // Go up two levels (from extension-id to User) then down to workspaceStorage
      return path.resolve(globalStoragePath, '..', '..', 'workspaceStorage')
    } catch {
      return undefined
    }
  }

  /**
   * Find sessionId by searching for tool call IDs in recent session files.
   * Uses exponential backoff to wait for session file to be written.
   *
   * Strategy:
   * 1. Get all chatSessions directories across all workspaces
   * 2. Filter to recently modified files (last 5 minutes)
   * 3. Sort by modification time (newest first)
   * 4. Search for tool call ID match
   * 5. If not found, wait with exponential backoff and retry
   * 6. Return sessionId from matching file, or null after 2 minute timeout
   *
   * @param toolCallIds - Tool call IDs from ccreq event (e.g., "tooluse_XXX")
   * @returns sessionId if found, null otherwise
   */
  async findSessionId(toolCallIds: string[]): Promise<string | null> {
    if (toolCallIds.length === 0) {
      return null
    }

    const startTime = Date.now()
    let backoffMs = SessionIdLookup.INITIAL_BACKOFF_MS
    let attempt = 0

    while (Date.now() - startTime < SessionIdLookup.MAX_WAIT_MS) {
      attempt++
      const result = await this.tryFindSessionId(toolCallIds)

      if (result) {
        return result
      }

      // Check if we have time for another attempt
      const elapsed = Date.now() - startTime
      if (elapsed + backoffMs >= SessionIdLookup.MAX_WAIT_MS) {
        break
      }

      // Wait with exponential backoff
      await this.sleep(backoffMs)
      backoffMs = Math.min(backoffMs * 2, 3000) // Cap at 3 seconds per wait
    }

    logger.warn(
      { toolCallIds: toolCallIds.slice(0, 3), attempts: attempt },
      'SessionId not found after timeout'
    )
    return null
  }

  /**
   * Single attempt to find sessionId in session files.
   */
  private async tryFindSessionId(
    toolCallIds: string[]
  ): Promise<string | null> {
    const chatSessionsDirs = await this.getAllChatSessionsPaths()
    if (chatSessionsDirs.length === 0) {
      return null
    }

    // Get recent session files sorted by modification time (newest first)
    const recentFiles = await this.getRecentSessionFiles(chatSessionsDirs)

    if (recentFiles.length === 0) {
      return null
    }

    // Search recent files for matching tool call ID
    for (const filePath of recentFiles) {
      let content: string
      try {
        content = await fs.promises.readFile(filePath, 'utf-8')
      } catch {
        continue
      }

      for (const toolCallId of toolCallIds) {
        if (content.includes(toolCallId)) {
          try {
            const session = JSON.parse(content) as { sessionId?: unknown }
            const { sessionId } = session

            if (typeof sessionId === 'string') {
              return sessionId
            }
          } catch {
            break // Don't try other toolCallIds for this malformed file
          }
        }
      }
    }

    return null
  }

  /**
   * Sleep for the specified duration.
   */
  private sleep(ms: number): Promise<void> {
    return setTimeout(ms)
  }

  /**
   * Get all chatSessions directory paths across all workspaces.
   */
  private async getAllChatSessionsPaths(): Promise<string[]> {
    const basePath = this.workspaceStoragePath
    if (!basePath) {
      return []
    }

    // Check if base path exists
    try {
      await fs.promises.access(basePath)
    } catch {
      return []
    }

    const dirs: string[] = []
    try {
      const workspaces = await fs.promises.readdir(basePath)
      for (const workspace of workspaces) {
        const chatSessionsPath = path.join(basePath, workspace, 'chatSessions')
        try {
          await fs.promises.access(chatSessionsPath)
          dirs.push(chatSessionsPath)
        } catch {
          // Directory doesn't exist, skip
        }
      }
    } catch {
      // Failed to enumerate workspace storage
    }

    return dirs
  }

  /**
   * Get recently modified session files, sorted by modification time (newest first).
   */
  private async getRecentSessionFiles(dirs: string[]): Promise<string[]> {
    const now = Date.now()
    const recentThreshold = now - SessionIdLookup.RECENT_THRESHOLD_MS
    const filesWithStats: { path: string; mtimeMs: number }[] = []

    for (const dir of dirs) {
      try {
        const files = await fs.promises.readdir(dir)
        for (const file of files) {
          if (!file.endsWith('.json')) {
            continue
          }

          const filePath = path.join(dir, file)
          try {
            const stat = await fs.promises.stat(filePath)
            if (stat.mtimeMs > recentThreshold) {
              filesWithStats.push({ path: filePath, mtimeMs: stat.mtimeMs })
            }
          } catch {
            // Skip files we can't stat
          }
        }
      } catch {
        // Skip directories we can't read
      }
    }

    // Sort by modification time, newest first
    return filesWithStats
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((f) => f.path)
  }
}

// Singleton instance
let sessionIdLookupInstance: SessionIdLookup | undefined

/**
 * Initialize the SessionIdLookup singleton with the extension context.
 * Must be called before getSessionIdLookup().
 */
export function initSessionIdLookup(context: vscode.ExtensionContext): void {
  if (!sessionIdLookupInstance) {
    sessionIdLookupInstance = new SessionIdLookup(context)
  }
}

/**
 * Get the singleton SessionIdLookup instance.
 * @throws Error if initSessionIdLookup was not called first
 */
export function getSessionIdLookup(): SessionIdLookup {
  if (!sessionIdLookupInstance) {
    throw new Error(
      'SessionIdLookup not initialized. Call initSessionIdLookup(context) first.'
    )
  }
  return sessionIdLookupInstance
}
