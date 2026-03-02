import * as vscode from 'vscode'

import { closeDB, initDB } from './cursor/db'
import { EXTENSION_NAME } from './env'
import { AuthManager } from './mobbdev_src/commands/AuthManager'
import { handleMobbLogin } from './mobbdev_src/commands/handleMobbLogin'
import {
  disposeCircularLog,
  initCircularLog,
  logError,
  logInfo,
} from './shared/circularLog'
import {
  getConfig,
  hasRelevantConfigurationChanged,
  initConfig,
} from './shared/config'
import { dailyMcpDetection } from './shared/DailyMcpDetection'
import { flushLogger, initLogger, logger } from './shared/logger'
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

    // Initialize circular log for crash forensics
    initCircularLog()
    logInfo('Extension activating')

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
    logInfo('Extension activated successfully')
  } catch (err) {
    logger.error({ err }, 'Failed to activate extension')
    logError(
      'Failed to activate extension',
      err instanceof Error ? err.message : String(err)
    )
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
  const hasToken = authManager.hasStoredToken()
  logger.info(
    { apiUrl, webAppUrl, hasStoredToken: hasToken },
    'Auth check starting'
  )

  // Retry auth check — a single transient network failure (timeout, DNS,
  // server cold-start) should not force the user through a full re-login.
  // Only retry when a token exists — retrying with no token is pointless.
  const AUTH_CHECK_RETRIES = hasToken ? 3 : 1
  const AUTH_RETRY_DELAY_MS = 2_000
  let authenticated = false
  for (let attempt = 1; attempt <= AUTH_CHECK_RETRIES; attempt++) {
    authManager.cleanup() // reset cached auth state for a fresh check
    authenticated = await authManager.isAuthenticated()
    if (authenticated) {
      break
    }
    if (attempt < AUTH_CHECK_RETRIES) {
      logger.warn(
        `Auth check failed (attempt ${attempt}/${AUTH_CHECK_RETRIES}), retrying in ${AUTH_RETRY_DELAY_MS}ms`
      )
      await new Promise((r) => setTimeout(r, AUTH_RETRY_DELAY_MS))
    }
  }

  if (authenticated) {
    logger.info('User is already authenticated')
  } else {
    // Show status bar auth indicator and register re-open command
    if (statusBar) {
      statusBar.setAuthPending('')
      context.subscriptions.push(
        vscode.commands.registerCommand(`${EXTENSION_NAME}.openAuthLink`, () =>
          authManager?.openUrlInBrowser()
        )
      )
    }

    // Delegate to handleMobbLogin which handles the full login flow:
    // generates login URL, opens browser, waits for authentication
    try {
      await handleMobbLogin({
        inGqlClient: authManager.getGQLClient(),
        skipPrompts: true,
        apiUrl,
        webAppUrl,
      })
      logger.info('User authenticated successfully')
      if (statusBar) {
        statusBar.clearAuthPending()
      }
    } catch (err) {
      logger.error({ err }, 'Authentication flow failed')
      statusBar?.error('Authentication failed')
    }
  }
}

export async function deactivate(): Promise<void> {
  try {
    logInfo('Extension deactivating')
    dailyMcpDetection.stop()

    if (monitorManager) {
      await monitorManager.stopAllMonitors()
      monitorManager = null
    }

    await closeDB()

    logger.info('Extension deactivated')
    logInfo('Extension deactivated')
    disposeCircularLog()
    flushLogger()
  } catch (err) {
    logger.error({ err }, 'Error during deactivation')
    logError(
      'Error during deactivation',
      err instanceof Error ? err.message : String(err)
    )
  }
}
