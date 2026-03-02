import { setTimeout } from 'node:timers/promises'

import * as vscode from 'vscode'

import { logHeartbeat, logInfo } from '../shared/circularLog'
import { BaseMonitor } from '../shared/IMonitor'
import { logger } from '../shared/logger'
import { AppType } from '../shared/repositoryInfo'
import { startupTimestamp } from '../shared/startupTimestamp'
import { uploadCursorChanges } from '../shared/uploader'
import { getCompletedFileEditBubblesSince } from './db'
import { processBubbles } from './processor'

const DEFAULT_POLLING_INTERVAL = 20_000
const BASE_POLLING_INTERVAL = process.env.MOBB_TRACER_POLL_INTERVAL_MS
  ? Number(process.env.MOBB_TRACER_POLL_INTERVAL_MS)
  : DEFAULT_POLLING_INTERVAL
const MAX_POLLING_INTERVAL = BASE_POLLING_INTERVAL * 6
const BATCH_SIZE = 50
const QUERY_LIMIT = 200
const CIRCUIT_BREAKER_THRESHOLD = 5
const CIRCUIT_BREAKER_COOLDOWN = 120_000

export class CursorMonitor extends BaseMonitor {
  readonly name = 'CursorMonitor'

  private startupTimestamp: Date
  private oldRowsLen = -1
  private pollingPromise: Promise<void> | null = null
  private abortController: AbortController | null = null
  private lastPollTimestamp: string | null = null
  private consecutiveFailures = 0
  private currentInterval = BASE_POLLING_INTERVAL

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

    // No startup scan needed — the incremental query only fetches rows
    // created after startupTimestamp, and processBubbles also filters by
    // createdAt < startupTimestamp as a safety net. Old bubbles are never
    // re-uploaded regardless.
    this.lastPollTimestamp = this.startupTimestamp.toISOString()

    this._isRunning = true
    this.abortController = new AbortController()
    this.pollingPromise = this.poll()

    logger.debug(`${this.name} started successfully`)
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
        // Apply jitter: ±20% of current interval
        const jitter = this.currentInterval * 0.2 * (Math.random() * 2 - 1)
        const delay = Math.round(this.currentInterval + jitter)

        await setTimeout(delay, undefined, {
          signal: this.abortController?.signal,
        })

        if (!this._isRunning || this.abortController?.signal.aborted) {
          break
        }

        // Circuit breaker: if too many consecutive failures, enter cooldown
        if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
          logger.warn(
            `${this.name} circuit breaker open (${this.consecutiveFailures} failures), cooling down ${CIRCUIT_BREAKER_COOLDOWN / 1000}s`
          )
          logHeartbeat('circuit breaker open', {
            failures: this.consecutiveFailures,
          })
          await setTimeout(CIRCUIT_BREAKER_COOLDOWN, undefined, {
            signal: this.abortController?.signal,
          })
          // Half-open: try one probe cycle
          this.consecutiveFailures = CIRCUIT_BREAKER_THRESHOLD - 1
        }

        // Use incremental query with time filter + limit
        const sinceIso =
          this.lastPollTimestamp || this.startupTimestamp.toISOString()
        const rows = await getCompletedFileEditBubblesSince(
          sinceIso,
          QUERY_LIMIT
        )

        const { changes, latestTimestamp, hasMore } = await processBubbles(
          rows,
          this.startupTimestamp,
          BATCH_SIZE
        )

        // Update high-water mark
        if (latestTimestamp) {
          this.lastPollTimestamp = latestTimestamp
        }

        // Success: reset backoff
        this.consecutiveFailures = 0
        this.currentInterval = BASE_POLLING_INTERVAL

        // Log to Datadog only when row count changes or changes found
        if (this.oldRowsLen !== rows.length || changes.length > 0) {
          this.oldRowsLen = rows.length
          logger.info(`Found ${rows.length} rows, ${changes.length} changes`)
        }

        // Heartbeat: separate ring buffer so idle polls don't push out operational logs
        logHeartbeat(`poll: ${rows.length} rows, ${changes.length} changes`, {
          hasMore,
        })

        if (changes.length > 0) {
          logInfo(
            `Processed ${changes.length} change(s)${hasMore ? ' (more pending)' : ''}`,
            { rows: rows.length }
          )
          await uploadCursorChanges(changes)
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          break
        }

        // Increment failure count and apply exponential backoff
        this.consecutiveFailures++
        this.currentInterval = Math.min(
          BASE_POLLING_INTERVAL * Math.pow(2, this.consecutiveFailures - 1),
          MAX_POLLING_INTERVAL
        )

        const errMsg = err instanceof Error ? err.message : String(err)
        if (
          errMsg.includes('SQLITE_BUSY') ||
          errMsg.includes('database is locked')
        ) {
          logger.warn({ err }, `${this.name} DB query failed, skipping cycle`)
        } else {
          logger.error({ err }, `Error in ${this.name} polling`)
        }

        logHeartbeat(
          `poll error (${this.consecutiveFailures}x), next in ${Math.round(this.currentInterval / 1000)}s`,
          {
            error: errMsg.slice(0, 100),
          }
        )
      }
    }
  }

  getStartupTimestamp(): Date {
    return this.startupTimestamp
  }
}
