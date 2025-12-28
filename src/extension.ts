import * as vscode from 'vscode'

// These imports are safe because they don't immediately execute code that reads constants
import { initDB } from './cursor/db'
// Import configLoader first, before any modules that might use constants
import {
  hasRelevantConfigurationChanged,
  loadConfigurationToEnv,
} from './shared/configLoader'
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
import { TraceyController } from './ui/TraceyController'
import { StatusBarView } from './ui/TraceyStatusBar'

let monitorManager: MonitorManager | null = null
let repoInfo: RepositoryInfo | null = null
let aiBlameCache: AIBlameCache | null = null
let gitBlameCache: GitBlameCache | null = null
let traceyController: TraceyController | null = null
let statusBarItem: vscode.StatusBarItem | null = null

export async function activate(context: vscode.ExtensionContext) {
  // Load VS Code configuration to environment variables FIRST
  // This must happen before any modules that use constants are imported/executed
  loadConfigurationToEnv()

  initLogger()

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
    // 3. The new configuration values are loaded into process.env
    // 4. All modules are re-imported and constants are re-evaluated with the new values
    // Note: We check if onDidChangeConfiguration exists to avoid errors in test environment
    if (vscode.workspace.onDidChangeConfiguration) {
      context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
          if (hasRelevantConfigurationChanged(e)) {
            vscode.window
              .showInformationMessage(
                'Mobb AI Tracer configuration changed. Reload window for changes to take effect.',
                'Reload Window'
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
  traceyController = new TraceyController(
    gitBlameCache,
    aiBlameCache,
    new StatusBarView(statusBarItem),
    repoInfo?.gitRepoUrl ?? ''
  )

  // Register disposables for cleanup
  context.subscriptions.push(statusBarItem)
  context.subscriptions.push({ dispose: () => traceyController?.dispose() })
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
