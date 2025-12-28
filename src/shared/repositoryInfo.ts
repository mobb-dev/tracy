import * as vscode from 'vscode'

import { getAuthenticatedGQLClient } from '../mobbdev_src/commands/handleMobbLogin'
import { GitService } from '../mobbdev_src/features/analysis/scm/services/GitService'
import { logger } from './logger'

export enum AppType {
  CURSOR = 'cursor',
  VSCODE = 'vscode',
  UNKNOWN = 'unknown',
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
  mobbAppBaseUrl: string
}

export async function getRepositoryInfo(): Promise<RepositoryInfo | null> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!workspaceFolder) {
    logger.warn('No workspace folder found')
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
    const gqlClient = await getAuthenticatedGQLClient({})
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

    // Detect app type
    const appType = detectAppType()

    const repoInfo: RepositoryInfo = {
      gitRepoUrl: gitUrl,
      gitRoot,
      userEmail: userInfo.email,
      organizationId: String(organizationId),
      appType,
      mobbAppBaseUrl: getAppBaseUrl(),
    }

    logger.info(
      `Repository info resolved - URL: ${gitUrl}, Email: ${userInfo.email}, Org: ${organizationId}, App: ${appType}`
    )
    return repoInfo
  } catch (error) {
    logger.error('Failed to get repository info', error)
    return null
  }
}

export function detectAppType(): AppType {
  const appName = vscode.env.appName.toLowerCase()
  logger.info(`App Name: ${appName}`)

  if (appName.includes('visual studio code')) {
    return AppType.VSCODE
  } else if (appName.includes('cursor')) {
    return AppType.CURSOR
  }
  logger.warn(`Unknown app: ${appName}`)
  return AppType.UNKNOWN
}

function getAppBaseUrl(): string {
  return process.env.APP_BASE_URL || ''
}
