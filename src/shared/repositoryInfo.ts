import { setTimeout } from 'node:timers/promises'

import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'

import { GitService } from '../mobbdev_src/features/analysis/scm/services/GitService'
import {
  parseScmURL,
  ScmType,
} from '../mobbdev_src/features/analysis/scm/shared/src/urlParser'
import { createGQLClient } from './gqlClientFactory'
import { logger } from './logger'

export let repoInfo: RepositoryInfo | null = null

export async function initRepoInfo(): Promise<void> {
  repoInfo = await getRepositoryInfo()
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
  if (env['VSCODE_IPC_HOOK'] || env['VSCODE_PID']) {
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

export type RepositoryInfo = {
  gitRepoUrl: string
  /**
   * Absolute path to the git repository root (top-level).
   * This may differ from the VS Code workspace folder when a subdirectory is opened.
   */
  gitRoot: string
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
async function waitForWorkspaceFolder(
  maxWaitMs: number = 5000,
  pollIntervalMs: number = 200
): Promise<string | null> {
  const startTime = Date.now()

  while (Date.now() - startTime < maxWaitMs) {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (folder) {
      return folder
    }
    await setTimeout(pollIntervalMs)
  }

  return null
}

export async function getRepositoryInfo(): Promise<RepositoryInfo | null> {
  // Wait for workspace folder with retry logic (handles race condition on startup)
  const workspaceFolder = await waitForWorkspaceFolder()
  if (!workspaceFolder) {
    logger.warn('No workspace folder found after waiting')
    return null
  }

  logger.info(`workspace folder: ${workspaceFolder}`)

  try {
    // Use GitService from CLI for git operations
    const gitService = new GitService(workspaceFolder)

    const isRepo = await gitService.isGitRepository()
    if (!isRepo) {
      logger.warn('Could not find git repository root')
      return null
    }

    const gitRoot = await gitService.getGitRoot()
    logger.info(`git root: ${gitRoot}`)

    // Get git remote URL (already normalized by GitService)
    const gitUrl = await gitService.getRemoteUrl()
    if (!gitUrl) {
      logger.warn('Could not determine git remote URL')
      return null
    }

    // Get organization ID from user info
    const gqlClient = await createGQLClient()
    const userInfo = await gqlClient.getUserInfo()
    logger.info(`user info: ${JSON.stringify(userInfo)}`)
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
      gitRepoUrl: gitUrl,
      gitRoot,
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
 * Gets the normalized GitHub repository URL from the current workspace.
 * Returns null if not in a git repository or if not a GitHub repository.
 * Only GitHub URLs are supported; non-GitHub repos return null.
 */
export async function getNormalizedGitHubRepoUrl(): Promise<string | null> {
  const workspaceFolder = await waitForWorkspaceFolder()
  if (!workspaceFolder) {
    return null
  }

  try {
    const gitService = new GitService(workspaceFolder)
    const isRepo = await gitService.isGitRepository()
    if (!isRepo) {
      return null
    }
    const remoteUrl = await gitService.getRemoteUrl()
    const parsed = parseScmURL(remoteUrl)
    return parsed?.scmType === ScmType.GitHub ? remoteUrl : null
  } catch {
    return null
  }
}

export function getIdeVersion(appType: AppType): string {
  switch (appType) {
    case AppType.VSCODE:
      return vscode.version
    case AppType.CURSOR:
      try {
        const productJsonPath = path.join(vscode.env.appRoot, 'product.json')
        const raw = fs.readFileSync(productJsonPath, 'utf-8')
        const productJson = JSON.parse(raw)
        return productJson.version || '0.0.0'
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
