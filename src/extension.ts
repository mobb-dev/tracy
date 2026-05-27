import * as fs from 'node:fs'
import * as path from 'node:path'

import * as vscode from 'vscode'

import {
  registerInlineCompletionStub,
  registerInlineCompletionTracker,
} from './copilot/inlineCompletionTracker'
import { closeDB, initDB } from './cursor/db'
import { EXTENSION_NAME } from './env'
import { AuthManager } from './mobbdev_src/commands/AuthManager'
import { handleMobbLogin } from './mobbdev_src/commands/handleMobbLogin'
import {
  getConfig,
  hasRelevantConfigurationChanged,
  initConfig,
} from './shared/config'
import { dailyMcpDetection } from './shared/DailyMcpDetection'
import {
  flushLogger,
  initLogger,
  logger,
  updateLoggerPlatformTags,
} from './shared/logger'
import { MonitorManager } from './shared/MonitorManager'
import {
  AppType,
  initRepoInfo,
  refreshRepositories,
  repoInfo,
} from './shared/repositoryInfo'
import { disposeContextFileWorker } from './shared/uploader'
import { TracyCoordinator } from './ui/TracyCoordinator'
import { StatusBarView } from './ui/TracyStatusBar'

let monitorManager: MonitorManager | null = null

let statusBarItem: vscode.StatusBarItem | null = null
let statusBar: StatusBarView | null = null
let coordinator: TracyCoordinator | null = null
let authManager: AuthManager | null = null
let dbRetryTimer: ReturnType<typeof globalThis.setTimeout> | null = null

const DB_RETRY_COOLDOWN_MS = 30 * 60 * 1000 // 30 minutes
const MAX_DB_RETRIES = 5 // stop after 2.5 hours
let dbRetryCount = 0

/**
 * Diagnostic-only activation trace. Writes one JSON line per stage to a file
 * the E2E test reads to figure out where activation stalled / failed. Opt-in
 * via `MOBB_E2E_ACTIVATION_TRACE=1` so it's a no-op in production.
 *
 * Never throws — diagnostics must not affect activation. The path is
 * derived from `context.globalStorageUri.fsPath`, which the test knows.
 */
function writeActivationTrace(
  context: vscode.ExtensionContext,
  stage: string,
  info: Record<string, unknown> = {}
): void {
  if (process.env.MOBB_E2E_ACTIVATION_TRACE !== '1') {
    return
  }
  const line = `${JSON.stringify(
    {
      ts: Date.now(),
      stage,
      gs: context.globalStorageUri.fsPath,
      ...info,
    },
    replacer
  )}\n`
  // 1) globalStorageUri-relative — what the extension *thinks* its storage is.
  try {
    const dir = context.globalStorageUri.fsPath
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, '_e2e-activation-trace.jsonl'), line)
  } catch {
    // Diagnostic only — swallow.
  }
  // 2) Backup at an absolute path passed via env var. Lets the test find the
  //    trace even if globalStorageUri resolves somewhere unexpected, which is
  //    the working theory for the Cursor+Windows "no trace file" failure.
  const backupPath = process.env.MOBB_E2E_ACTIVATION_TRACE_PATH
  if (backupPath) {
    try {
      fs.mkdirSync(path.dirname(backupPath), { recursive: true })
      fs.appendFileSync(backupPath, line)
    } catch {
      // Swallow.
    }
  }
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  return value
}

export async function activate(context: vscode.ExtensionContext) {
  writeActivationTrace(context, 'activate:start', {
    extensionPath: context.extensionPath,
    appName: vscode.env.appName,
    nodeVersion: process.version,
    platform: process.platform,
  })

  // Initialize configuration from THIS extension's package.json
  // Each extension has its own extensionPath, so dev and prod get different configs
  initConfig(context.extensionPath)

  const config = getConfig()

  initLogger()

  const { apiUrl, webAppUrl, isDevExtension } = config
  const isLocalEnv = apiUrl.includes('localhost')

  writeActivationTrace(context, 'config:loaded', {
    apiUrl,
    webAppUrl,
    isLocalEnv,
    isDevExtension,
    isConfigFromPackageJson: config.isConfigFromPackageJson,
  })

  logger.info(
    { apiUrl, webAppUrl, isLocalEnv, isDevExtension },
    `Extension environment: ${isLocalEnv ? 'LOCAL' : isDevExtension ? 'DEV' : 'PRODUCTION'}`
  )

  // Register passthrough stub early so the Tab keybinding declared in package.json
  // never triggers "command not found", even if activation fails or is still in progress.
  registerInlineCompletionStub(context)

  try {
    // Initialize status bar, we need it for auth status updates
    statusBar = initStatusBar(context)

    // Get authenticated before starting monitoring
    await getAuthenticated(context, webAppUrl, apiUrl)
    writeActivationTrace(context, 'auth:done')

    // Initialize repository info, needs to be done after auth but before monitoring
    await initRepoInfo()
    if (!repoInfo) {
      throw new Error('Failed to get repository info')
    }
    writeActivationTrace(context, 'repoInfo:done', {
      appType: repoInfo.appType,
      ideVersion: repoInfo.ideVersion,
      repoCount: repoInfo.repositories.length,
    })
    logger.info(`Repository info: ${JSON.stringify(repoInfo)}`)

    // Enrich DDtags with platform/environment info now that repoInfo is available
    updateLoggerPlatformTags(repoInfo.appType, repoInfo.ideVersion)

    logger.info('Extension activating')

    // Initialize web panel components
    setupView(context)

    dailyMcpDetection.start()
    monitorManager = new MonitorManager(context, repoInfo.appType)

    // Initialize database for Cursor — wrapped in its own try/catch so
    // DB issues never prevent the rest of the extension from starting.
    let dbInitFailed = false
    if (repoInfo.appType === AppType.CURSOR) {
      try {
        await initDB(context)
        writeActivationTrace(context, 'initDB:done')
      } catch (dbErr) {
        dbInitFailed = true
        writeActivationTrace(context, 'initDB:failed', { err: dbErr })
        logger.error(
          { err: dbErr },
          'Failed to initialize Cursor DB — CursorMonitor will not start. Scheduling retry.'
        )
        scheduleDbRetry(context)
      }
    }

    // Start appropriate monitoring — skip CursorMonitor if DB init failed
    // (it would poll but always get empty results, wasting CPU)
    await monitorManager.startMonitoring(
      dbInitFailed ? ['CursorMonitor'] : undefined
    )
    writeActivationTrace(context, 'monitoring:started', {
      skippedCursorMonitor: dbInitFailed,
    })

    // Track Copilot inline completion acceptances (VS Code only — Cursor has its own tab tracking)
    if (repoInfo.appType === AppType.VSCODE) {
      registerInlineCompletionTracker(context)
    }

    // Refresh workspace repo mapping when folders change (user adds/removes workspace folder)
    if (vscode.workspace.onDidChangeWorkspaceFolders) {
      context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(async (e) => {
          logger.info(
            `Workspace folders changed: +${e.added.length} -${e.removed.length}`
          )
          try {
            await refreshRepositories()
            logger.info(
              `Repositories refreshed: ${repoInfo?.repositories.map((r) => r.gitRepoUrl).join(', ')}`
            )
          } catch (err) {
            logger.warn(
              { err },
              'Failed to refresh repositories after workspace change'
            )
          }
        })
      )
    }

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
    writeActivationTrace(context, 'activate:success')
  } catch (err) {
    writeActivationTrace(context, 'activate:failed', { err })
    // Log at error level so the problem is visible in Datadog and extension output,
    // but do NOT re-throw — we must never crash the extension host.
    const errMsg = err instanceof Error ? err.message : String(err)
    logger.error({ err }, 'Failed to activate extension')

    // Show degraded state in the status bar so the user knows something is wrong
    if (statusBar) {
      statusBar.error(`Activation failed: ${errMsg}`)
    }
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
  if (
    !repoInfo ||
    !repoInfo.organizationId ||
    !repoInfo.repositories ||
    repoInfo.repositories.length === 0
  ) {
    logger.error('Repository info is not available for view setup')
    return
  }

  if (!statusBar) {
    logger.error('Status bar is not available for view setup')
    return
  }

  coordinator = new TracyCoordinator(
    repoInfo.repositories,
    repoInfo.organizationId,
    statusBar
  )
  context.subscriptions.push({ dispose: () => coordinator?.dispose() })
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
        skipPrompts: true,
        apiUrl,
        webAppUrl,
        authManager,
      })
      logger.info('User authenticated successfully')
      if (statusBar) {
        statusBar.clearAuthPending()
        coordinator?.refreshActiveEditor()
      }
    } catch (err) {
      logger.error({ err }, 'Authentication flow failed')
      statusBar?.error('Authentication failed')
    }
  }
}

/**
 * Schedule a DB initialization retry after a cooldown period.
 * If initDB failed at startup (e.g., DB locked, file missing), we wait 30 minutes
 * and try again. If it still fails, we schedule another retry.
 */
function scheduleDbRetry(context: vscode.ExtensionContext): void {
  if (dbRetryTimer) {
    return
  }

  dbRetryCount++
  if (dbRetryCount > MAX_DB_RETRIES) {
    logger.error(
      `Cursor DB initialization failed after ${MAX_DB_RETRIES} retries (${(MAX_DB_RETRIES * DB_RETRY_COOLDOWN_MS) / 60_000} min) — giving up. CursorMonitor will not start.`
    )
    logger.error('initDB retries exhausted — CursorMonitor will not start.')
    return
  }

  dbRetryTimer = globalThis.setTimeout(async () => {
    dbRetryTimer = null
    try {
      logger.info(
        `Retrying Cursor DB initialization (attempt ${dbRetryCount}/${MAX_DB_RETRIES})`
      )
      await initDB(context)
      logger.info('Cursor DB initialized on retry — starting CursorMonitor')
      dbRetryCount = 0

      // All monitor start() methods are idempotent (check _isRunning),
      // so calling startMonitoring() again is safe for already-running monitors.
      if (monitorManager) {
        await monitorManager.startMonitoring()
      }
    } catch (err) {
      logger.error(
        { err },
        `Cursor DB retry ${dbRetryCount}/${MAX_DB_RETRIES} failed — scheduling another`
      )
      scheduleDbRetry(context)
    }
  }, DB_RETRY_COOLDOWN_MS)
}

export async function deactivate(): Promise<void> {
  try {
    logger.info('Extension deactivating')

    if (dbRetryTimer) {
      clearTimeout(dbRetryTimer)
      dbRetryTimer = null
    }

    dailyMcpDetection.stop()

    if (monitorManager) {
      await monitorManager.stopAllMonitors()
      monitorManager = null
    }

    disposeContextFileWorker()

    await closeDB()

    logger.info('Extension deactivated')
    flushLogger()
  } catch (err) {
    logger.error({ err }, 'Error during deactivation')
  }
}
