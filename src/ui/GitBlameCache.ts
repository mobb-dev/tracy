import { spawn } from 'child_process'
import { promises as fsPromises } from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as vscode from 'vscode'

import {
  BlameLineInfo,
  buildGitBlameArgs,
  parseGitBlamePorcelainByLine,
} from '../mobbdev_src/utils/blame/gitBlameUtils'
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
      const blameInfo: GitBlameInfo = await new Promise<GitBlameInfo>(
        (resolve, reject) => {
          let settled = false
          const safeResolve = (value: GitBlameInfo): void => {
            if (settled) {
              return
            }
            settled = true
            resolve(value)
          }
          const safeReject = (error: unknown): void => {
            if (settled) {
              return
            }
            settled = true
            reject(error)
          }

          let proc: ReturnType<typeof spawn>
          try {
            proc = spawn('git', args, {
              cwd: repoRoot,
              stdio: ['ignore', 'pipe', 'pipe'],
            })
          } catch (error) {
            safeReject(error)
            return
          }

          let stdout = ''
          let stderr = ''

          // If the process cannot be spawned (e.g., git is missing), Node will
          // emit an `error` event and may never emit `close`.
          proc.once('error', (error: Error) => {
            safeReject(error)
          })

          const stdoutStream = proc.stdout
          const stderrStream = proc.stderr
          if (!stdoutStream || !stderrStream) {
            try {
              proc.kill()
            } catch {
              /* ignore */
            }
            safeReject(new Error('Failed to spawn git blame process'))
            return
          }

          stdoutStream.on('data', (data: Buffer) => {
            stdout += data.toString()
          })

          stderrStream.on('data', (data: Buffer) => {
            stderr += data.toString()
          })

          stdoutStream.once('error', (error: Error) => {
            safeReject(error)
          })
          stderrStream.once('error', (error: Error) => {
            safeReject(error)
          })

          proc.once('close', (code: number) => {
            if (code !== 0) {
              safeReject(new Error(`Git blame failed: ${stderr}`))
              return
            }
            // Parse the porcelain format output to extract line -> hash mapping
            const lines = parseGitBlamePorcelainByLine(stdout)
            safeResolve({ lines, documentVersion: document.version || 0 })
          })
        }
      )
      return blameInfo
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
