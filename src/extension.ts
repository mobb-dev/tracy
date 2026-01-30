import open from 'open'
import * as vscode from 'vscode'

import { initDB } from './cursor/db'
import { EXTENSION_NAME } from './env'
import { AuthManager } from './mobbdev_src/commands/AuthManager'
import {
  getConfig,
  hasRelevantConfigurationChanged,
  initConfig,
} from './shared/config'
import { dailyMcpDetection } from './shared/DailyMcpDetection'
import { initLogger, logger } from './shared/logger'
import { MonitorManager } from './shared/MonitorManager'
import { AppType, initRepoInfo, repoInfo } from './shared/repositoryInfo'
import { AIBlameCache } from './ui/AIBlameCache'
import { GitBlameCache } from './ui/GitBlameCache'
import { TracyController } from './ui/TracyController'
import { StatusBarView } from './ui/TracyStatusBar'

let monitorManager: MonitorManager | null = null

let aiBlameCache: AIBlameCache | null = null
let gitBlameCache: GitBlameCache | null = null
let tracyController: TracyController | null = null
let statusBarItem: vscode.StatusBarItem | null = null
let statusBar: StatusBarView | null = null
let authManager: AuthManager | null = null
let authLink: string | null = null

export async function activate(context: vscode.ExtensionContext) {
  // Initialize configuration from THIS extension's package.json
  // Each extension has its own extensionPath, so dev and prod get different configs
  initConfig(context.extensionPath)

  const config = getConfig()

  initLogger()

  const { apiUrl, webAppUrl, isDevExtension } = config
  const isLocalEnv = apiUrl.includes('localhost')

  logger.info(
    { apiUrl, webAppUrl, isLocalEnv, isDevExtension },
    `Extension environment: ${isLocalEnv ? 'LOCAL' : isDevExtension ? 'DEV' : 'PRODUCTION'}`
  )
  try {
    // Initialize status bar, we need it for auth status updates
    statusBar = initStatusBar(context)

    // Get authenticated before starting monitoring
    await getAuthenticated(context, webAppUrl, apiUrl)

    // Initialize repository info, needs to be done after auth but before monitoring
    await initRepoInfo()
    if (!repoInfo) {
      throw new Error('Failed to get repository info')
    }
    logger.info(`Repository info: ${JSON.stringify(repoInfo)}`)

    // Initialize web panel components
    setupView(context)

    dailyMcpDetection.start()
    monitorManager = new MonitorManager(context, repoInfo.appType)

    // Initialize database for Cursor
    if (repoInfo.appType === AppType.CURSOR) {
      await initDB(context)
    }

    // Start appropriate monitoring
    await monitorManager.startMonitoring()

    // Register configuration change listener
    // When configuration changes, we need to reload the window because:
    // 1. Reloading the window completely restarts the extension process
    // 2. The extension's activate() function runs again from scratch
    // 3. The new configuration values are loaded
    // Note: We check if onDidChangeConfiguration exists to avoid errors in test environment
    if (vscode.workspace.onDidChangeConfiguration) {
      context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
          if (hasRelevantConfigurationChanged(e)) {
            vscode.window
              .showInformationMessage(
                'Mobb AI Tracer configuration changed. Reload window for changes to take effect.',
                'Reload Window',
                'Later'
              )
              .then((selection) => {
                if (selection === 'Reload Window') {
                  vscode.commands.executeCommand(
                    'workbench.action.reloadWindow'
                  )
                }
              })
          }
        })
      )
    }
    logger.info('Extension activated successfully')
  } catch (err) {
    logger.error({ err }, 'Failed to activate extension')
    throw err
  }
}

function initStatusBar(context: vscode.ExtensionContext): StatusBarView {
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right
  )
  context.subscriptions.push(statusBarItem)
  return new StatusBarView(statusBarItem)
}

function setupView(context: vscode.ExtensionContext): void {
  if (!repoInfo || !repoInfo.organizationId || !repoInfo.gitRepoUrl) {
    logger.error('Repository info is not available for view setup')
    return
  }
  if (!statusBar) {
    logger.error('Status bar is not available for view setup')
    return
  }
  aiBlameCache = new AIBlameCache(
    repoInfo.gitRepoUrl,
    repoInfo.organizationId,
    repoInfo.gitRoot
  )
  gitBlameCache = new GitBlameCache(
    repoInfo.gitRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''
  )
  tracyController = new TracyController(
    gitBlameCache,
    aiBlameCache,
    statusBar,
    repoInfo?.gitRepoUrl ?? ''
  )

  // Register disposables for cleanup
  context.subscriptions.push({ dispose: () => tracyController?.dispose() })
  context.subscriptions.push({ dispose: () => aiBlameCache?.dispose() })
  context.subscriptions.push({ dispose: () => gitBlameCache?.dispose() })
}

async function getAuthenticated(
  context: vscode.ExtensionContext,
  webAppUrl?: string,
  apiUrl?: string
): Promise<void> {
  authManager = new AuthManager(webAppUrl, apiUrl)
  if (await authManager.isAuthenticated()) {
    logger.info('User is already authenticated')
  } else {
    authLink = await authManager.generateLoginUrl()
    if (authLink && statusBar) {
      statusBar.setAuthPending(authLink)
      // Register command to open/copy auth link
      context.subscriptions.push(
        vscode.commands.registerCommand(
          `${EXTENSION_NAME}.openAuthLink`,
          async () => {
            if (authLink) {
              try {
                await open(authLink)
              } catch (e) {
                await vscode.env.clipboard.writeText(authLink)
                vscode.window.showInformationMessage(
                  'Auth link copied to clipboard.'
                )
              }
            }
          }
        )
      )
    } else {
      logger.error('Failed to generate authentication link')
      statusBar?.error('Authentication link generation failed')
    }
    const isAuthenticated = await authManager.waitForAuthentication()
    if (isAuthenticated) {
      logger.info('User authenticated successfully')
      if (statusBar) {
        statusBar.clearAuthPending()
      }
    }
  }
}

export async function deactivate(): Promise<void> {
  try {
    dailyMcpDetection.stop()

    if (monitorManager) {
      await monitorManager.stopAllMonitors()
      monitorManager = null
    }
    logger.info('Extension deactivated')
  } catch (err) {
    logger.error({ err }, 'Error during deactivation')
  }
}
