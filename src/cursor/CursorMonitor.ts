import { setTimeout } from 'node:timers/promises'

import * as vscode from 'vscode'

import { BaseMonitor } from '../shared/IMonitor'
import { logger } from '../shared/logger'
import { AppType } from '../shared/repositoryInfo'
import { startupTimestamp } from '../shared/startupTimestamp'
import { uploadCursorChanges } from '../shared/uploader'
import { getCompletedFileEditBubbles } from './db'
import { markExistingToolCallsAsUploaded, processBubbles } from './processor'

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
      logger.debug(`${this.name} is already running`)
      return
    }

    logger.debug(`Starting ${this.name}`)

    try {
      // Fetch only completed file edits (bubbles with codeblockId)
      // This is much more efficient than fetching all bubbles
      const rows = await getCompletedFileEditBubbles()
      markExistingToolCallsAsUploaded(rows)

      this._isRunning = true
      this.abortController = new AbortController()
      this.pollingPromise = this.poll()

      logger.debug(`${this.name} started successfully`)
    } catch (err) {
      // Checkpoint failures during startup are recoverable - start polling anyway
      // The poll loop will retry and eventually succeed
      const errMsg = err instanceof Error ? err.message : String(err)
      if (
        errMsg.includes('SQLITE_BUSY') ||
        errMsg.includes('database is locked')
      ) {
        logger.warn(
          { err },
          `${this.name} initial DB query failed, starting polling anyway`
        )
        this._isRunning = true
        this.abortController = new AbortController()
        this.pollingPromise = this.poll()
      } else {
        logger.error({ err }, `Failed to start ${this.name}`)
        this._isRunning = false
        throw err
      }
    }
  }

  async stop(): Promise<void> {
    if (!this._isRunning) {
      return
    }

    logger.debug(`Stopping ${this.name}`)
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

    logger.debug(`${this.name} stopped`)
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

        // Fetch only completed file edits (optimized query)
        const rows = await getCompletedFileEditBubbles()

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
        // Checkpoint failures (e.g., SQLITE_BUSY) are expected when Cursor holds the lock
        // Log as warning and skip this cycle - will retry on next poll
        const errMsg = err instanceof Error ? err.message : String(err)
        if (
          errMsg.includes('SQLITE_BUSY') ||
          errMsg.includes('database is locked')
        ) {
          logger.warn({ err }, `${this.name} DB query failed, skipping cycle`)
        } else {
          logger.error({ err }, `Error in ${this.name} polling`)
        }
        // Continue polling even after errors
      }
    }
  }

  getStartupTimestamp(): Date {
    return this.startupTimestamp
  }
}
