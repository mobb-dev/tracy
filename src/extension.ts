import * as vscode from 'vscode'

// These imports are safe because they don't immediately execute code that reads constants
import { initDB } from './cursor/db'
// Import configLoader first, before any modules that might use constants
import {
  hasRelevantConfigurationChanged,
  loadConfigurationToEnv,
} from './shared/configLoader'
import { dailyMcpDetection } from './shared/DailyMcpDetection'
import { AppType } from './shared/IMonitor'
import { initLogger, logger } from './shared/logger'
import { MonitorManager } from './shared/MonitorManager'
import { getAuthenticatedForUpload } from './shared/uploader'

let monitorManager: MonitorManager | null = null

export async function activate(context: vscode.ExtensionContext) {
  // Load VS Code configuration to environment variables FIRST
  // This must happen before any modules that use constants are imported/executed
  loadConfigurationToEnv()

  initLogger()

  await getAuthenticatedForUpload()

  try {
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
