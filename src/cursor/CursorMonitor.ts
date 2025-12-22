import { setTimeout } from 'node:timers/promises'

import * as vscode from 'vscode'

import { AppType, BaseMonitor } from '../shared/IMonitor'
import { logger } from '../shared/logger'
import { startupTimestamp } from '../shared/startupTimestamp'
import { uploadCursorChanges } from '../shared/uploader'
import { getRowsByLike } from './db'
import { ignoreBubbles, processBubbles } from './processor'

const POLLING_INTERVAL = 5000

export class CursorMonitor extends BaseMonitor {
  readonly name = 'CursorMonitor'

  private startupTimestamp: Date
  private oldRowsLen = -1
  private pollingPromise: Promise<void> | null = null
  private abortController: AbortController | null = null

  constructor(
    private context: vscode.ExtensionContext,
    appType: AppType
  ) {
    super(appType)
    this.startupTimestamp = startupTimestamp
  }

  async start(): Promise<void> {
    if (this._isRunning) {
      logger.info(`${this.name} is already running`)
      return
    }

    logger.info(`Starting ${this.name}`)

    try {
      const rows = await getRowsByLike({
        key: 'bubbleId:%',
        keyOnly: true,
      })
      ignoreBubbles(rows)

      this._isRunning = true
      this.abortController = new AbortController()
      this.pollingPromise = this.poll()

      logger.info(`${this.name} started successfully`)
    } catch (err) {
      logger.error({ err }, `Failed to start ${this.name}`)
      this._isRunning = false
      throw err
    }
  }

  async stop(): Promise<void> {
    if (!this._isRunning) {
      return
    }

    logger.info(`Stopping ${this.name}`)
    this._isRunning = false

    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }

    if (this.pollingPromise) {
      try {
        await this.pollingPromise
      } catch (err) {
        // Ignore abort errors
        if (err instanceof Error && err.name !== 'AbortError') {
          logger.error({ err }, `Error while stopping ${this.name}`)
        }
      }
      this.pollingPromise = null
    }

    logger.info(`${this.name} stopped`)
  }

  private async poll(): Promise<void> {
    while (this._isRunning && !this.abortController?.signal.aborted) {
      try {
        await setTimeout(POLLING_INTERVAL, undefined, {
          signal: this.abortController?.signal,
        })

        if (!this._isRunning || this.abortController?.signal.aborted) {
          break
        }

        const rows = await getRowsByLike({
          key: 'bubbleId:%',
          keyOnly: true,
        })
        const changes = await processBubbles(rows, this.startupTimestamp)

        // Log only if something changed
        if (this.oldRowsLen !== rows.length || changes.length > 0) {
          this.oldRowsLen = rows.length
          logger.info(`Found ${rows.length} rows, ${changes.length} changes`)
        }

        if (changes.length > 0) {
          await uploadCursorChanges(changes)
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          break
        }
        logger.error({ err }, `Error in ${this.name} polling`)
        // Continue polling even after errors
      }
    }
  }

  getStartupTimestamp(): Date {
    return this.startupTimestamp
  }
}
