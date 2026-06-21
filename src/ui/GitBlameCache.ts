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
import { pathsEqual } from '../shared/pathUtils'

export type GitBlameLineInfo = BlameLineInfo

export type GitBlameInfo = {
  documentVersion: number
  lines: Record<number, GitBlameLineInfo>
}

// Size cap to prevent unbounded memory growth
const MAX_CACHE_SIZE = 100

/** Minimal shape of the vscode.git API we depend on (subset of `git.d.ts`). */
type GitRepository = {
  rootUri: vscode.Uri
  state: {
    HEAD?: { commit?: string }
    onDidChange: (cb: () => void) => vscode.Disposable
  }
}
type GitApi = {
  state: 'uninitialized' | 'initialized'
  repositories: GitRepository[]
  onDidChangeState: (
    cb: (state: 'uninitialized' | 'initialized') => void
  ) => vscode.Disposable
  onDidOpenRepository: (cb: (repo: GitRepository) => void) => vscode.Disposable
}
type GitExtensionExports = { getAPI: (version: number) => GitApi }

export class GitBlameCache {
  private gitHeadDisposable: vscode.Disposable | undefined
  /** Transient listeners used while resolving the repo (state/open events). */
  private gitSetupDisposables: vscode.Disposable[] = []
  /** Set in dispose() so the async setup can bail and not leak listeners. */
  private disposed = false
  private cache = new Map<string, GitBlameInfo>()
  private lastHeadCommit: string | undefined

  constructor(private repoPath: string) {
    // Fire-and-forget: the HEAD listener is non-critical and its setup is
    // async (it may need to activate vscode.git). It must never throw out of
    // the constructor — this runs synchronously during extension activation,
    // and a throw here would abort the whole Tracy coordinator/monitor.
    void this.setupGitHeadListener()
  }

  private async setupGitHeadListener(): Promise<void> {
    try {
      const gitExtension = vscode.extensions.getExtension('vscode.git')
      if (!gitExtension) {
        logger.warn(
          { repoPath: this.repoPath },
          'GitBlameCache: vscode.git extension not found, HEAD listener not set up.'
        )
        return
      }
      // Reading `.exports` before the extension is activated throws
      // ("Extension 'vscode.git' is not known or not activated"). Activation
      // order between extensions isn't guaranteed, so activate it first.
      if (!gitExtension.isActive) {
        await gitExtension.activate()
      }
      if (this.disposed) {
        return
      }
      const git = (
        gitExtension.exports as GitExtensionExports | undefined
      )?.getAPI(1)
      if (!git) {
        logger.warn(
          { repoPath: this.repoPath },
          'GitBlameCache: git API unavailable, HEAD listener not set up.'
        )
        return
      }
      // `git.repositories` is populated asynchronously, so it is usually empty
      // right after activation. Wait for the API to finish initializing before
      // reading it, otherwise the listener would silently never attach.
      if (git.state !== 'initialized') {
        await this.waitForGitInitialized(git)
        if (this.disposed) {
          return
        }
      }
      const repo = git.repositories.find((r) =>
        pathsEqual(r.rootUri.fsPath, this.repoPath)
      )
      if (repo) {
        this.attachHeadListener(repo)
        return
      }
      // Our repo isn't open yet — attach if/when it is opened later.
      const openDisposable = git.onDidOpenRepository((opened) => {
        if (
          this.disposed ||
          !pathsEqual(opened.rootUri.fsPath, this.repoPath)
        ) {
          return
        }
        this.attachHeadListener(opened)
      })
      this.gitSetupDisposables.push(openDisposable)
    } catch (err) {
      // Degrade gracefully: without the listener the blame cache simply won't
      // auto-clear on HEAD change — far better than aborting activation.
      logger.warn(
        { err, repoPath: this.repoPath },
        'GitBlameCache: failed to set up git HEAD listener'
      )
    }
  }

  /** Resolves once the git API is `initialized` (so `repositories` is filled). */
  private waitForGitInitialized(git: GitApi): Promise<void> {
    return new Promise<void>((resolve) => {
      const stateDisposable = git.onDidChangeState((state) => {
        if (state === 'initialized') {
          stateDisposable.dispose()
          resolve()
        }
      })
      this.gitSetupDisposables.push(stateDisposable)
    })
  }

  /** Wire the HEAD-change listener for a resolved repository. */
  private attachHeadListener(repo: GitRepository): void {
    if (this.disposed) {
      return
    }
    this.lastHeadCommit = repo.state.HEAD?.commit
    this.gitHeadDisposable = repo.state.onDidChange(() => {
      const newCommit = repo.state.HEAD?.commit
      // same branch name, different commit => a commit happened; drop the cache
      if (newCommit && newCommit !== this.lastHeadCommit) {
        logger.info(
          `GitBlameCache: Detected HEAD change from ${this.lastHeadCommit} to ${newCommit}, clearing blame cache.`
        )
        this.lastHeadCommit = newCommit
        this.cache.clear()
      }
    })
  }

  private async getBlameInfo(
    document: vscode.TextDocument
  ): Promise<GitBlameInfo> {
    logger.debug(
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

    // Skip files outside the repo (cross-repo files, symlinks)
    // to avoid 8+ rapid git errors like "fatal: pathspec is beyond a symbolic link"
    if (relPath.startsWith('..')) {
      logger.debug(
        `GitBlameCache: skipping file outside repo: ${absPath} (relPath: ${relPath})`
      )
      return { lines: {}, documentVersion: document.version || 0 }
    }

    // If the document is dirty, write to a temp file for --contents flag
    let tempFilePath: string | undefined
    if (document.isDirty) {
      const tempDir = os.tmpdir()
      const safeInput = path.basename(
        String(
          `gitblamecache_${Date.now()}_${path.basename(document.fileName)}` ||
            ''
        )
          .replace('\0', '')
          .replace(/^(\.\.(\/|\\$))+/, '')
      )
      tempFilePath = path.join(tempDir, safeInput)
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
    this.disposed = true
    this.gitHeadDisposable?.dispose()
    for (const d of this.gitSetupDisposables) {
      d.dispose()
    }
    this.gitSetupDisposables = []
    this.clearAll()
  }
}
