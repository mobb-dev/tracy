import * as vscode from 'vscode'

import { CopilotMonitor } from '../copilot/CopilotMonitor'
import { CursorMonitor } from '../cursor/CursorMonitor'
import { CursorTabMonitor } from '../cursor_tab/CursorTabMonitor'
import { HumanTrackingSession } from '../human/HumanMonitor'
import { IMonitor } from './IMonitor'
import { logger } from './logger'
import { AppType, detectAppType } from './repositoryInfo'

export class MonitorManager {
  private monitors = new Map<AppType, IMonitor[]>()
  private currentAppType: AppType

  constructor(private context: vscode.ExtensionContext) {
    this.currentAppType = detectAppType()
    this.initializeMonitors()
  }

  private initializeMonitors(): void {
    this.monitors.set(AppType.CURSOR, [
      new CursorMonitor(this.context, AppType.CURSOR),
      new CursorTabMonitor(this.context, AppType.CURSOR),
      new HumanTrackingSession(this.context, AppType.CURSOR),
    ])
    this.monitors.set(AppType.VSCODE, [
      new CopilotMonitor(this.context, AppType.VSCODE),
      new HumanTrackingSession(this.context, AppType.VSCODE),
    ])
  }

  async startMonitoring(): Promise<void> {
    const monitor = this.monitors.get(this.currentAppType)

    if (!monitor) {
      logger.warn(`No monitor available for app type: ${this.currentAppType}`)
      return
    }

    try {
      await Promise.all(
        monitor.map(async (monitor) => {
          await monitor.start()
        })
      )
      logger.info(`Started monitoring for ${this.currentAppType}`)
    } catch (err) {
      logger.error(
        { err },
        `Failed to start monitoring for ${this.currentAppType}`
      )
      throw err
    }
  }

  async stopMonitoring(): Promise<void> {
    const runningMonitors = Array.from(this.monitors.values())
      .flat()
      .filter((m) => m.isRunning())

    await Promise.all(
      runningMonitors.map(async (monitor) => {
        try {
          await monitor.stop()
          logger.info(`Stopped ${monitor.name}`)
        } catch (err) {
          logger.error({ err }, `Failed to stop ${monitor.name}`)
        }
      })
    )
  }

  async stopAllMonitors(): Promise<void> {
    await Promise.all(
      Array.from(this.monitors.values())
        .flat()
        .map(async (monitor) => {
          if (monitor.isRunning()) {
            try {
              await monitor.stop()
              logger.info(`Stopped ${monitor.name}`)
            } catch (err) {
              logger.error({ err }, `Failed to stop ${monitor.name}`)
            }
          }
        })
    )
  }

  getAppType(): AppType {
    return this.currentAppType
  }

  getRunningMonitors(): IMonitor[] {
    return Array.from(this.monitors.values())
      .flat()
      .filter((m) => m.isRunning())
  }

  isMonitoringActive(): boolean {
    return this.getRunningMonitors().length > 0
  }

  // For debugging/testing purposes
  async forceStartMonitor(appType: AppType): Promise<void> {
    const monitors = this.monitors.get(appType)
    if (!monitors) {
      throw new Error(`No monitor available for app type: ${appType}`)
    }

    await Promise.all(
      monitors.map(async (monitor) => {
        await monitor.start()
      })
    )
  }
}
