import * as vscode from 'vscode'

import { initDB } from './cursor/db'
import {
  getConfig,
  hasRelevantConfigurationChanged,
  initConfig,
} from './shared/config'
import { dailyMcpDetection } from './shared/DailyMcpDetection'
import { initLogger, logger } from './shared/logger'
import { MonitorManager } from './shared/MonitorManager'
import {
  AppType,
  getRepositoryInfo,
  RepositoryInfo,
} from './shared/repositoryInfo'
import { getAuthenticatedForUpload } from './shared/uploader'
import { AIBlameCache } from './ui/AIBlameCache'
import { GitBlameCache } from './ui/GitBlameCache'
import { TracyController } from './ui/TracyController'
import { StatusBarView } from './ui/TracyStatusBar'

let monitorManager: MonitorManager | null = null
let repoInfo: RepositoryInfo | null = null
let aiBlameCache: AIBlameCache | null = null
let gitBlameCache: GitBlameCache | null = null
let tracyController: TracyController | null = null
let statusBarItem: vscode.StatusBarItem | null = null

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

  await getAuthenticatedForUpload()

  try {
    repoInfo = await getRepositoryInfo()
    setupView(context)

    dailyMcpDetection.start()

    monitorManager = new MonitorManager(context)
    const appType = monitorManager.getAppType()

    logger.info({ appType }, 'Detected app type')

    // Initialize database for Cursor
    if (appType === AppType.CURSOR) {
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

function setupView(context: vscode.ExtensionContext): void {
  if (!repoInfo || !repoInfo.organizationId || !repoInfo.gitRepoUrl) {
    logger.error('Repository info is not available for view setup')
    return
  }
  aiBlameCache = new AIBlameCache(repoInfo.gitRepoUrl, repoInfo.organizationId)
  gitBlameCache = new GitBlameCache(
    repoInfo.gitRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''
  )
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right
  )
  tracyController = new TracyController(
    gitBlameCache,
    aiBlameCache,
    new StatusBarView(statusBarItem),
    repoInfo?.gitRepoUrl ?? ''
  )

  // Register disposables for cleanup
  context.subscriptions.push(statusBarItem)
  context.subscriptions.push({ dispose: () => tracyController?.dispose() })
  context.subscriptions.push({ dispose: () => aiBlameCache?.dispose() })
  context.subscriptions.push({ dispose: () => gitBlameCache?.dispose() })
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
