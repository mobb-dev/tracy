import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import * as path from 'node:path'
import { setTimeout } from 'node:timers/promises'

import * as vscode from 'vscode'

import { GitService } from '../mobbdev_src/features/analysis/scm/services/GitService'
import { parseScmURL } from '../mobbdev_src/features/analysis/scm/shared/src/urlParser'
import { createGQLClient } from './gqlClientFactory'
import { logger } from './logger'

export let repoInfo: RepositoryInfo | null = null

export async function initRepoInfo(): Promise<void> {
  repoInfo = await getRepositoryInfo()
}

/**
 * Refreshes only the git repositories in the existing repoInfo.
 * This is more efficient than full re-initialization when we just need to detect newly added repos.
 * @returns true if repositories were successfully refreshed, false if no existing repoInfo to update
 */
export async function refreshRepositories(): Promise<boolean> {
  if (!repoInfo) {
    logger.warn('No existing repoInfo to refresh, call initRepoInfo() first')
    return false
  }

  try {
    // Wait for workspace folders (same as in getRepositoryInfo)
    const workspaceFolders = await waitForWorkspaceFolders()
    if (workspaceFolders.length === 0) {
      logger.warn('No workspace folders found during repository refresh')
      return false
    }

    // Get all git repositories across all workspace folders
    const allRepositories: GitRepository[] = []
    for (const folder of workspaceFolders) {
      const repos = await getWorkspaceGitRepositories(folder)
      allRepositories.push(...repos)
    }

    // Deduplicate by gitRoot (same repo may appear via multiple workspace folders)
    const seen = new Set<string>()
    const gitRepositories = allRepositories.filter((r) => {
      if (seen.has(r.gitRoot)) {
        return false
      }
      seen.add(r.gitRoot)
      return true
    })

    // Update only the repositories in the existing repoInfo
    const previousCount = repoInfo.repositories.length
    repoInfo.repositories = gitRepositories

    logger.info(
      `Repository refresh completed: ${previousCount} -> ${gitRepositories.length} repositories`
    )

    if (gitRepositories.length > previousCount) {
      logger.info('New repositories detected after refresh')
    }

    return true
  } catch (error) {
    logger.error({ error }, 'Failed to refresh repositories')
    return false
  }
}

/** @internal Test-only helper to set repoInfo state. */
export function _setRepoInfoForTesting(info: RepositoryInfo | null): void {
  repoInfo = info
}

/**
 * Finds all git repositories within a directory.
 * Recursively searches subdirectories (max depth 2) for .git folders.
 * Optimized for performance with parallel processing and smart exclusions.
 * @param directory The root directory to search in
 * @param maxDepth Maximum recursion depth (default: 2, reduced for performance)
 * @returns Array of absolute paths to git repository roots
 */
async function findGitRepositories(
  directory: string,
  maxDepth: number = 2
): Promise<string[]> {
  const gitRepos: string[] = []

  // Common directories to skip for performance
  const skipDirectories = new Set([
    'node_modules',
    '.git',
    '.svn',
    '.hg',
    'build',
    'dist',
    'target',
    'bin',
    'obj',
    '.next',
    '.nuxt',
    'coverage',
    '.nyc_output',
    'tmp',
    'temp',
    '.cache',
    '.vscode',
    '.idea',
    '__pycache__',
    '.pytest_cache',
    'venv',
    '.venv',
    '.env',
    'vendor',
  ])

  async function searchDirectory(
    dir: string,
    currentDepth: number
  ): Promise<void> {
    if (currentDepth > maxDepth) {
      return
    }

    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true })

      // Quick check if current directory has .git folder
      const hasGit = entries.some(
        (entry) => entry.isDirectory() && entry.name === '.git'
      )
      if (hasGit) {
        gitRepos.push(dir)
        return // Don't search nested repos
      }

      // Collect subdirectories to search in parallel
      const subDirectories: string[] = []
      for (const entry of entries) {
        if (
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          !skipDirectories.has(entry.name)
        ) {
          if (entry.name.includes('..') || entry.name.includes('\0')) {
            continue // Skip suspicious entries
          }
          // Pre-filters above already reject traversal attempts (.., \0, dot-prefixed).
          // Use path.join directly and verify the result stays within the parent.
          const subPath = path.join(dir, entry.name)
          if (!subPath.startsWith(dir + path.sep)) {
            continue // Skip if resolved path escapes the parent directory
          }
          subDirectories.push(subPath)
        }
      }

      // Search subdirectories in parallel (but limit concurrency to avoid overwhelming the system)
      const chunkSize = 10 // Process 10 directories at a time
      for (let i = 0; i < subDirectories.length; i += chunkSize) {
        const chunk = subDirectories.slice(i, i + chunkSize)
        await Promise.all(
          chunk.map((subDir) => searchDirectory(subDir, currentDepth + 1))
        )
      }
    } catch (error) {
      // Ignore permission errors and continue silently
      if (currentDepth === 0) {
        logger.debug(`Error scanning root directory ${dir}:`, error)
      }
    }
  }

  await searchDirectory(directory, 0)
  return gitRepos
}

/**
 * Supported IDE/editor types for tracking and analytics.
 * Keep in sync with clients/cli/src/mcp/services/types.ts
 */
export type IDE =
  | 'cursor'
  | 'vscode'
  | 'windsurf'
  | 'claude'
  | 'webstorm'
  | 'unknown'

/**
 * AppType enum-like object for backward compatibility.
 * Provides the same interface as the old enum: AppType.VSCODE, AppType.CURSOR, etc.
 */
export const AppType = {
  CURSOR: 'cursor',
  VSCODE: 'vscode',
  WINDSURF: 'windsurf',
  CLAUDE: 'claude',
  WEBSTORM: 'webstorm',
  UNKNOWN: 'unknown',
} as const

export type AppType = (typeof AppType)[keyof typeof AppType]

/**
 * Detects the IDE/editor host based on environment variables.
 * Detection order: Cursor, Windsurf, Claude, WebStorm, VS Code (last since others are forks)
 * @returns The detected IDE or 'unknown' if no IDE could be detected
 */
function detectIDEFromEnv(): IDE {
  const { env } = process

  // Check specific IDEs first (more specific env vars)
  if (env['CURSOR_TRACE_ID'] || env['CURSOR_SESSION_ID']) {
    return 'cursor'
  }
  if (env['WINDSURF_IPC_HOOK'] || env['WINDSURF_PID']) {
    return 'windsurf'
  }
  if (env['CLAUDE_DESKTOP'] || env['ANTHROPIC_CLAUDE']) {
    return 'claude'
  }
  if (
    env['WEBSTORM_VM_OPTIONS'] ||
    env['IDEA_VM_OPTIONS'] ||
    env['JETBRAINS_IDE']
  ) {
    return 'webstorm'
  }
  // Cursor and Windsurf are VS Code forks — they set VSCODE_IPC_HOOK/VSCODE_PID too.
  // Check vscode.env.appName before falling back to generic VS Code detection.
  if (env['VSCODE_IPC_HOOK'] || env['VSCODE_PID']) {
    const appName = vscode.env.appName?.toLowerCase() ?? ''
    if (appName.includes('cursor')) {
      return 'cursor'
    }
    if (appName.includes('windsurf')) {
      return 'windsurf'
    }
    return 'vscode'
  }

  // Fallback to TERM_PROGRAM
  const termProgram = env['TERM_PROGRAM']?.toLowerCase()
  if (termProgram === 'windsurf') {
    return 'windsurf'
  }
  if (termProgram === 'vscode') {
    return 'vscode'
  }

  return 'unknown'
}

export type GitRepository = {
  gitRepoUrl: string
  /**
   * Absolute path to the git repository root (top-level).
   * This may differ from the VS Code workspace folder when a subdirectory is opened.
   */
  gitRoot: string
}

export type RepositoryInfo = {
  repositories: GitRepository[]
  userEmail: string
  organizationId: string
  appType: AppType
  ideVersion: string // default to 0.0.0 if unknown
  mobbAppBaseUrl: string
}

/**
 * Wait for workspace folders to be available.
 * VS Code/Cursor may not have workspaceFolders populated immediately on startup,
 * even after the onStartupFinished activation event fires.
 */
async function waitForWorkspaceFolders(
  maxWaitMs: number = 5000,
  pollIntervalMs: number = 200
): Promise<string[]> {
  const startTime = Date.now()

  while (Date.now() - startTime < maxWaitMs) {
    const folders = vscode.workspace.workspaceFolders
    if (folders && folders.length > 0) {
      return folders.map((f) => f.uri.fsPath)
    }
    await setTimeout(pollIntervalMs)
  }

  return []
}

export async function getRepositoryInfo(): Promise<RepositoryInfo | null> {
  // Wait for workspace folders with retry logic (handles race condition on startup)
  const workspaceFolders = await waitForWorkspaceFolders()
  if (workspaceFolders.length === 0) {
    logger.warn('No workspace folders found after waiting')
    return null
  }

  logger.info(`workspace folders: ${workspaceFolders.join(', ')}`)

  try {
    // Get all git repositories across all workspace folders
    const allRepositories: GitRepository[] = []
    for (const folder of workspaceFolders) {
      const repos = await getWorkspaceGitRepositories(folder)
      allRepositories.push(...repos)
    }

    // Deduplicate by gitRoot (same repo may appear via multiple workspace folders)
    const seen = new Set<string>()
    const gitRepositories = allRepositories.filter((r) => {
      if (seen.has(r.gitRoot)) {
        return false
      }
      seen.add(r.gitRoot)
      return true
    })

    if (gitRepositories.length === 0) {
      logger.warn('No git repositories found in workspace')
      return null
    }

    logger.info(`Found ${gitRepositories.length} git repositories in workspace`)
    if (gitRepositories.length > 1) {
      logger.info(
        'Multi-repo setup detected:',
        gitRepositories.map((r) => r.gitRoot)
      )
    }

    // Get organization ID from user info
    const gqlClient = await createGQLClient()
    const userInfo = await gqlClient.getUserInfo()
    logger.info(
      {
        email: userInfo?.email,
        id: userInfo?.id,
        scmTypes: userInfo?.scmConfigs?.map((c) => c?.scmType),
      },
      'user info'
    )
    if (!userInfo?.email) {
      logger.warn('Could not get user email from user info')
      return null
    }

    // Get organization ID using the same method as uploader
    const { organizationId } = await gqlClient.getLastOrg(userInfo.email)

    if (!organizationId) {
      logger.warn('Could not get organization ID from user info')
      return null
    }

    const appType = detectAppType()
    const IDEversion = getIdeVersion(appType)
    const repoInfo: RepositoryInfo = {
      repositories: gitRepositories,
      userEmail: userInfo.email,
      organizationId: String(organizationId),
      appType,
      ideVersion: IDEversion,
      mobbAppBaseUrl: getAppBaseUrl(),
    }
    return repoInfo
  } catch (error) {
    logger.error({ error }, 'Failed to get repository info')
    return null
  }
}

/**
 * Gets all git repositories found in the current workspace.
 * Useful for debugging multi-repo setups or providing repository selection UI.
 * @returns Array of GitRepository objects, or empty array if none found
 */
export async function getWorkspaceGitRepositories(
  workspaceFolder: string
): Promise<GitRepository[]> {
  try {
    const results: GitRepository[] = []

    // Check if the workspace folder itself is a git repository
    const gitService = new GitService(workspaceFolder)
    const isRepo = await gitService.isGitRepository()

    if (isRepo) {
      const gitRoot = await gitService.getGitRoot()
      const gitUrl = await gitService.getRemoteUrl()

      if (gitUrl) {
        results.push({ gitRoot, gitRepoUrl: gitUrl })
        logger.info(`Found git repository at workspace root: ${gitRoot}`)
      } else {
        logger.warn('Git repository found but no remote URL available')
      }
    }

    // Always search for nested repositories (submodules, monorepo children).
    // findGitRepositories already skips .git so it won't re-find the root repo,
    // but we deduplicate by gitRoot below just in case.
    const gitRepoPaths = await findGitRepositories(workspaceFolder)

    if (gitRepoPaths.length > 0) {
      logger.debug(
        `Scanning ${gitRepoPaths.length} nested git candidate(s) in ${workspaceFolder}`
      )

      const repoResults = await Promise.all(
        gitRepoPaths.map(async (repoPath): Promise<GitRepository | null> => {
          try {
            const repoGitService = new GitService(repoPath)
            const repoIsGit = await repoGitService.isGitRepository()

            if (repoIsGit) {
              const gitUrl = await repoGitService.getRemoteUrl()
              if (gitUrl) {
                return { gitRoot: repoPath, gitRepoUrl: gitUrl }
              }
              logger.warn(`Repository ${repoPath} has no remote URL, skipping`)
            }
            return null
          } catch (error) {
            logger.warn(`Error processing repository ${repoPath}:`, error)
            return null
          }
        })
      )
      // Deduplicate by gitRoot (findGitRepositories re-finds the root at depth 0)
      const existingRoots = new Set(results.map((r) => r.gitRoot))
      for (const repo of repoResults) {
        if (repo && !existingRoots.has(repo.gitRoot)) {
          logger.info(
            `Added nested repository: ${repo.gitRoot} -> ${repo.gitRepoUrl}`
          )
          results.push(repo)
          existingRoots.add(repo.gitRoot)
        }
      }
    }

    // Sort longest gitRoot first so nested repos (submodules) are matched before
    // their parent when iterating with Array.find().
    results.sort((a, b) => b.gitRoot.length - a.gitRoot.length)
    return results
  } catch (error) {
    logger.error({ error }, 'Failed to get workspace git repositories')
    return []
  }
}

export function detectAppType(): AppType {
  // Try environment variable detection first (shared logic with CLI/MCP)
  const envDetected = detectIDEFromEnv()
  if (envDetected !== 'unknown') {
    logger.info(`App detected from env: ${envDetected}`)
    return envDetected
  }

  // Fall back to vscode.env.appName for VS Code-based editors
  const appName = vscode.env.appName.toLowerCase()
  logger.info(`App Name from vscode.env: ${appName}`)

  if (appName.includes('cursor')) {
    return AppType.CURSOR
  } else if (appName.includes('windsurf')) {
    return AppType.WINDSURF
  } else if (appName.includes('visual studio code')) {
    return AppType.VSCODE
  }

  logger.warn(`Unknown app: ${appName}`)
  return AppType.UNKNOWN
}

function getAppBaseUrl(): string {
  const baseUrl = process.env.APP_BASE_URL
  if (!baseUrl) {
    logger.warn('APP_BASE_URL environment variable not set, using empty string')
  }
  return baseUrl ?? ''
}

/**
 * Gets the Git repository information for a given file path.
 * Exported for testing; prefer getNormalizedRepoUrl for production use.
 * @param filePath The file path to check
 * @returns The GitRepository if found, otherwise null
 */
export function getRelevantRepo(filePath?: string): GitRepository | null {
  if (!repoInfo) {
    logger.error('Repository info is not initialized')
    return null
  }
  if (repoInfo.repositories.length === 0) {
    logger.warn('No repositories found in repository info')
    return null
  } else if (repoInfo.repositories.length === 1) {
    return repoInfo.repositories[0]
  } else if (filePath) {
    // Sort by longest gitRoot first to prefer the most specific match
    // (avoids /project matching /project-utils)
    const sorted = [...repoInfo.repositories].sort(
      (a, b) => b.gitRoot.length - a.gitRoot.length
    )
    for (const repo of sorted) {
      if (
        filePath.startsWith(repo.gitRoot + path.sep) ||
        filePath === repo.gitRoot
      ) {
        return repo
      }
    }
    logger.warn('No repository found matching the provided file path')
    return null
  }

  logger.warn(
    'Multiple repositories found but no file path provided to determine relevant repository'
  )
  return null
}

/**
 * Gets the normalized repository URL from the current workspace.
 * Returns null if not in a git repository or if the URL is not a recognized SCM provider.
 * Supports GitHub, GitLab, Azure DevOps, and Bitbucket repositories.
 * For multi-repo workspaces, returns the repository matching the given filePath.
 * If no repo is found for the given filePath, triggers a rescan to detect newly added repositories.
 */
/**
 * Discover a git repository from a file path by running git CLI commands
 * from the file's directory. Handles worktrees and repos outside workspace
 * folders. If found, adds the repo to the in-memory repoInfo list so
 * subsequent lookups are fast.
 */
async function discoverRepoFromFilePath(
  filePath: string
): Promise<GitRepository | null> {
  try {
    const stat = await fsPromises.stat(filePath)
    const dir = stat.isDirectory() ? filePath : path.dirname(filePath)

    const gitService = new GitService(dir)
    const isRepo = await gitService.isGitRepository()
    if (!isRepo) {
      return null
    }

    const gitRoot = await gitService.getGitRoot()
    const gitUrl = await gitService.getRemoteUrl()
    if (!gitUrl) {
      return null
    }

    const repo: GitRepository = { gitRoot, gitRepoUrl: gitUrl }

    // Add to in-memory list so future lookups don't need git CLI
    if (repoInfo) {
      const exists = repoInfo.repositories.some((r) => r.gitRoot === gitRoot)
      if (!exists) {
        repoInfo.repositories.push(repo)
        logger.info(`Discovered repo from file path: ${gitRoot} → ${gitUrl}`)
      }
    }

    return repo
  } catch (err) {
    logger.error({ err }, `Failed to discover repo from file path: ${filePath}`)
    return null
  }
}

/**
 * Resolve the GitRepository (URL + gitRoot) for a file path, applying the
 * same refresh+discover fallback as getNormalizedRepoUrl. Returns null if no
 * repo is found or the remote URL is not a recognized SCM provider.
 */
export async function getNormalizedRepo(
  filePath?: string
): Promise<GitRepository | null> {
  let repo = getRelevantRepo(filePath)

  // If no repo found and we have a filePath, try refreshing repos in case new ones were added
  if (!repo && filePath) {
    logger.info(
      `No repository found for file path: ${filePath}, refreshing repository list`
    )
    const refreshed = await refreshRepositories()

    if (refreshed) {
      repo = getRelevantRepo(filePath)

      if (repo) {
        logger.info(`Found repository after refresh: ${repo.gitRoot}`)
      }
    }

    // Still not found — try discovering the repo directly from the file path.
    // Handles worktrees and repos outside the workspace folders.
    if (!repo) {
      repo = await discoverRepoFromFilePath(filePath)
    }
  }

  if (!repo) {
    if (filePath) {
      logger.warn(`No git repository found for file path: ${filePath}`)
    }
    return null
  }

  const parsed = parseScmURL(repo.gitRepoUrl)
  if (parsed?.scmType && parsed.scmType !== 'Unknown') {
    return repo
  }

  return null
}

export async function getNormalizedRepoUrl(
  filePath?: string
): Promise<string | null> {
  const repo = await getNormalizedRepo(filePath)
  return repo?.gitRepoUrl ?? null
}

/**
 * Reads the IDE version once at startup. The result is stored in
 * repoInfo.ideVersion so no additional caching is needed here.
 */
function getIdeVersion(appType: AppType): string {
  switch (appType) {
    case AppType.VSCODE:
      return vscode.version
    case AppType.CURSOR:
      try {
        const productJsonPath = path.join(vscode.env.appRoot, 'product.json')
        const raw = fs.readFileSync(productJsonPath, 'utf-8')
        const productJson = JSON.parse(raw)
        return (productJson.version as string) || '0.0.0'
      } catch (error) {
        logger.error(
          { error },
          'Failed to read Cursor product.json for IDE version'
        )
        return '0.0.0'
      }
    default:
      return '0.0.0'
  }
}
