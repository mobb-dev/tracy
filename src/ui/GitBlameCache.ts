import { promises as fsPromises } from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as vscode from 'vscode'

import {
  BlameLineInfo,
  buildGitBlameArgs,
  parseGitBlamePorcelainByLine,
} from '../mobbdev_src/utils/blame/gitBlameUtils'
import { createGitWithLogging } from '../mobbdev_src/utils/gitUtils'
import { logger } from '../shared/logger'

export type GitBlameLineInfo = BlameLineInfo

export type GitBlameInfo = {
  documentVersion: number
  lines: Record<number, GitBlameLineInfo>
}

// Size cap to prevent unbounded memory growth
const MAX_CACHE_SIZE = 100

export class GitBlameCache {
  private cache = new Map<string, GitBlameInfo>()

  constructor(private repoPath: string) {}

  private async getBlameInfo(
    document: vscode.TextDocument
  ): Promise<GitBlameInfo> {
    logger.info(
      `Fetching git blame for ${document.fileName} (version: ${document.version})`
    )
    const cached = this.cache.get(document.uri.fsPath)

    // Check if cache is valid (exists and version matches)
    if (cached && cached.documentVersion === document.version) {
      return cached
    }

    // Cache miss or version mismatch - fetch fresh data
    const blameInfo = await this.blameFile(this.repoPath, document)
    this.setCached(document.uri.fsPath, blameInfo)
    return blameInfo
  }

  private setCached(key: string, value: GitBlameInfo): void {
    // Evict oldest entries if cache is full
    while (this.cache.size >= MAX_CACHE_SIZE) {
      const oldestKey = this.cache.keys().next().value
      if (oldestKey) {
        this.cache.delete(oldestKey)
      }
    }
    this.cache.set(key, value)
  }

  private async blameFile(
    repoRoot: string,
    document: vscode.TextDocument
  ): Promise<GitBlameInfo> {
    const absPath = document.uri.fsPath
    const relPath = path
      .relative(repoRoot, absPath)
      .split(path.sep)
      .join(path.posix.sep)

    // If the document is dirty, write to a temp file for --contents flag
    let tempFilePath: string | undefined
    if (document.isDirty) {
      const tempDir = os.tmpdir()
      tempFilePath = path.join(
        tempDir,
        `gitblamecache_${Date.now()}_${path.basename(document.fileName)}`
      )
      await fsPromises.writeFile(tempFilePath, document.getText(), 'utf8')
    }
    const cleanupTempFile = async (): Promise<void> => {
      if (!tempFilePath) {
        return
      }
      try {
        await fsPromises.unlink(tempFilePath)
      } catch {
        /* ignore */
      } finally {
        tempFilePath = undefined
      }
    }

    // Build args using shared function
    const args = buildGitBlameArgs({
      filePath: relPath,
      contentsPath: tempFilePath,
      mode: 'workingTree',
    })

    try {
      const git = createGitWithLogging(repoRoot, logger)
      const blameOutput = await git.raw(args)

      // Parse the porcelain format output to extract line -> hash mapping, including author info
      const lines = parseGitBlamePorcelainByLine(blameOutput)
      // lines: Record<number, { commit, originalLine, authorName, authorEmail }>
      return { lines, documentVersion: document.version || 0 }
    } finally {
      await cleanupTempFile()
    }
  }

  async getBlame(document: vscode.TextDocument): Promise<GitBlameInfo | null> {
    try {
      const blameInfo = await this.getBlameInfo(document)
      return blameInfo || null
    } catch (error: unknown) {
      // Graceful fallback for modified files
      const message =
        typeof error === 'object' && error && 'message' in error
          ? (error as { message: string }).message
          : String(error)
      logger.warn(`Git blame failed for ${document.fileName}: ${message}`)
      return null
    }
  }

  async getBlameLine(
    document: vscode.TextDocument,
    lineNumber: number
  ): Promise<GitBlameLineInfo | null> {
    try {
      const blameInfo = await this.getBlameInfo(document)
      return blameInfo.lines[lineNumber] || null
    } catch (error: unknown) {
      // Graceful fallback for modified files
      const message =
        typeof error === 'object' && error && 'message' in error
          ? (error as { message: string }).message
          : String(error)
      logger.warn(`Git blame failed for ${document.fileName}: ${message}`)
      return null
    }
  }

  clearFile(fileName: string): void {
    this.cache.delete(fileName)
  }

  clearAll(): void {
    this.cache.clear()
  }

  dispose(): void {
    this.clearAll()
  }
}
