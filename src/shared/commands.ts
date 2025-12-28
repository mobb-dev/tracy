import * as vscode from 'vscode'

import { EXTENSION_NAME } from '../env'
import { logger } from '../shared/logger'
import { MonitorManager } from '../shared/MonitorManager'
import { AppType } from './repositoryInfo'

export function registerMonitorCommands(
  context: vscode.ExtensionContext,
  monitorManager: MonitorManager
) {
  // Command to check monitor status
  const statusCommand = vscode.commands.registerCommand(
    `${EXTENSION_NAME}.monitor.status`,
    () => {
      const appType = monitorManager.getAppType()
      const runningMonitors = monitorManager.getRunningMonitors()
      const isActive = monitorManager.isMonitoringActive()

      const statusMessage = `
App Type: ${appType}
Monitoring Active: ${isActive}
Running Monitors: ${runningMonitors.map((m) => m.name).join(', ') || 'None'}
      `.trim()

      vscode.window.showInformationMessage(statusMessage)
      logger.info(statusMessage)
    }
  )

  // Command to restart monitoring
  const restartCommand = vscode.commands.registerCommand(
    `${EXTENSION_NAME}.monitor.restart`,
    async () => {
      try {
        await monitorManager.stopAllMonitors()
        await monitorManager.startMonitoring()
        vscode.window.showInformationMessage('Monitor restarted successfully')
      } catch (e) {
        const message = `Failed to restart monitor: ${e instanceof Error ? e.message : String(e)}`
        vscode.window.showErrorMessage(message)
      }
    }
  )

  // Debug command to force start specific monitor (for testing)
  const forceStartCommand = vscode.commands.registerCommand(
    `${EXTENSION_NAME}.monitor.forceStart`,
    async () => {
      const options = Object.values(AppType).map((type) => ({
        label: type,
        value: type,
      }))
      const selected = await vscode.window.showQuickPick(options, {
        placeHolder: 'Select monitor to start',
      })

      if (selected) {
        try {
          await monitorManager.forceStartMonitor(selected.value)
          vscode.window.showInformationMessage(
            `Started ${selected.value} monitor`
          )
        } catch (e) {
          const message = `Failed to start ${selected.value} monitor: ${e instanceof Error ? e.message : String(e)}`
          vscode.window.showErrorMessage(message)
        }
      }
    }
  )

  context.subscriptions.push(statusCommand, restartCommand, forceStartCommand)
}
