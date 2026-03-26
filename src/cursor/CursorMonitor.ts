import { setTimeout } from 'node:timers/promises'

import * as vscode from 'vscode'

import { BaseMonitor } from '../shared/IMonitor'
import { logger } from '../shared/logger'
import { AppType } from '../shared/repositoryInfo'
import { uploadCursorRawRecords } from '../shared/uploader'
import { getRecentBubbleKeys, prefetchSessions } from './db'
import {
  cleanupStaleCursors,
  type CursorRawRecord,
  discoverActiveSessions,
  getCursorRowId,
  getIncompleteBubbleKeys,
  prepareSessionForUpload,
  revisitIncompleteBubbles,
  updateIncompleteBubbles,
} from './rawProcessor'

const DEFAULT_POLLING_INTERVAL = 20_000
const BASE_POLLING_INTERVAL = process.env.MOBB_TRACER_POLL_INTERVAL_MS
  ? Number(process.env.MOBB_TRACER_POLL_INTERVAL_MS)
  : DEFAULT_POLLING_INTERVAL
const MAX_POLLING_INTERVAL = BASE_POLLING_INTERVAL * 6
const RECENT_DISCOVERY_LIMIT = 500
const CIRCUIT_BREAKER_THRESHOLD = 5
const CIRCUIT_BREAKER_COOLDOWN = 120_000
const MAX_SESSIONS_PER_CYCLE = 5

export class CursorMonitor extends BaseMonitor {
  readonly name = 'CursorMonitor'

  private pollingPromise: Promise<void> | null = null
  private abortController: AbortController | null = null
  private consecutiveFailures = 0
  private currentInterval = BASE_POLLING_INTERVAL

  constructor(
    private context: vscode.ExtensionContext,
    appType: AppType
  ) {
    super(appType)
  }

  async start(): Promise<void> {
    if (this._isRunning) {
      logger.debug(`${this.name} is already running`)
      return
    }

    logger.debug(`Starting ${this.name}`)

    // Clean up stale cursor keys from configStore on startup
    cleanupStaleCursors()

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
          logger.info(
            { heartbeat: true, data: { failures: this.consecutiveFailures } },
            'circuit breaker open'
          )
          await setTimeout(CIRCUIT_BREAKER_COOLDOWN, undefined, {
            signal: this.abortController?.signal,
          })
          // Half-open: try one probe cycle
          this.consecutiveFailures = CIRCUIT_BREAKER_THRESHOLD - 1
        }

        // 1. Discover active sessions (recent keys + persisted cursors)
        const recentKeys = await getRecentBubbleKeys(RECENT_DISCOVERY_LIMIT)
        const allSessionIds = discoverActiveSessions(recentKeys)
        const sessionIds = allSessionIds.slice(0, MAX_SESSIONS_PER_CYCLE)

        // 2. Prefetch: batch-fetch all sessions in a single worker call
        //    (single DB connection open/close = single lock acquisition)
        const prefetchedSessions = await prefetchSessions(
          sessionIds.map((composerId) => ({
            composerId,
            afterRowId: getCursorRowId(composerId),
            incompleteBubbleKeys: getIncompleteBubbleKeys(composerId),
          }))
        )

        // 3. Process: prepare records in-memory (zero DB access)
        const allRecords: CursorRawRecord[] = []
        const allIncomplete = new Map<
          string,
          { key: string; firstSeenAt: number }[]
        >()
        const maxRowIds = new Map<string, number>()
        for (const {
          composerId,
          bubbles,
          composerDataValue,
          revisitedBubbles,
        } of prefetchedSessions) {
          // Process new bubbles
          const { records, newIncomplete, maxRowId } = prepareSessionForUpload(
            bubbles,
            composerId,
            composerDataValue
          )
          allRecords.push(...records)
          if (maxRowId != null) {
            maxRowIds.set(composerId, maxRowId)
          }

          // Revisit previously-incomplete bubbles
          const sessionIncomplete = [...newIncomplete]
          if (revisitedBubbles.length > 0) {
            const revisited = revisitIncompleteBubbles(
              revisitedBubbles,
              composerId,
              composerDataValue
            )
            allRecords.push(...revisited.records)
            sessionIncomplete.push(...revisited.stillIncomplete)
          }

          // Track merged incomplete list (or empty to clear)
          allIncomplete.set(composerId, sessionIncomplete)
        }

        if (allRecords.length === 0) {
          logger.debug(
            { heartbeat: true },
            `poll: ${sessionIds.length} sessions, 0 records`
          )
        }

        // 4. Upload all records in a single batch
        if (allRecords.length > 0) {
          logger.info(
            { heartbeat: true },
            `Uploading ${allRecords.length} record(s) from ${sessionIds.length} session(s)`
          )
          await uploadCursorRawRecords(allRecords, allIncomplete, maxRowIds)
        }

        // 5. Update incomplete bubble lists for sessions not handled in step 4
        const uploadedSessionIds = new Set(
          allRecords.map((r) => r.metadata.sessionId)
        )
        for (const [composerId, incomplete] of allIncomplete) {
          if (!uploadedSessionIds.has(composerId)) {
            updateIncompleteBubbles(
              composerId,
              incomplete,
              maxRowIds.get(composerId)
            )
          }
        }

        // Success: reset backoff after upload completes
        this.consecutiveFailures = 0
        this.currentInterval = BASE_POLLING_INTERVAL
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          break
        }

        const errMsg = err instanceof Error ? err.message : String(err)
        const isLockError =
          errMsg.includes('SQLITE_BUSY') ||
          errMsg.includes('database is locked')

        if (isLockError) {
          // Transient lock contention — skip this cycle, don't penalize.
          // Cursor is likely writing to its DB. We'll try again next cycle.
          logger.warn({ err }, `${this.name} DB query failed, skipping cycle`)
          logger.info({ heartbeat: true }, 'poll skipped (db locked)')
        } else {
          // Actual error — apply exponential backoff
          this.consecutiveFailures++
          this.currentInterval = Math.min(
            BASE_POLLING_INTERVAL * Math.pow(2, this.consecutiveFailures - 1),
            MAX_POLLING_INTERVAL
          )
          logger.error({ err }, `Error in ${this.name} polling`)
          logger.info(
            { heartbeat: true, data: { error: errMsg.slice(0, 100) } },
            `poll error (${this.consecutiveFailures}x), next in ${Math.round(this.currentInterval / 1000)}s`
          )
        }
      }
    }
  }
}
