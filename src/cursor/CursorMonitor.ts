import { setTimeout } from 'node:timers/promises'

import * as vscode from 'vscode'

import { CircuitBreaker } from '../shared/CircuitBreaker'
import { BaseMonitor } from '../shared/IMonitor'
import { logger } from '../shared/logger'
import { buildCycleHeartbeat } from '../shared/machineContext'
import { AppType } from '../shared/repositoryInfo'
import {
  uploadContextFilesForSession,
  uploadCursorRawRecords,
} from '../shared/uploader'
import {
  consumeWorkerPerf,
  getRecentBubbleKeys,
  isWorkerAvailable,
  prefetchSessions,
  recycleWorker,
} from './db'
import {
  cleanupStaleCursors,
  type CursorRawRecord,
  discoverActiveSessions,
  getCursorRowId,
  getIncompleteBubbleKeys,
  groupRecentKeysBySession,
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
const MAX_RECORDS_PER_CYCLE = 200

export class CursorMonitor extends BaseMonitor {
  readonly name = 'CursorMonitor'

  private pollingPromise: Promise<void> | null = null
  private abortController: AbortController | null = null
  private breaker = new CircuitBreaker({
    name: 'CursorMonitor',
    threshold: 5,
    cooldownMs: 120_000,
    baseIntervalMs: BASE_POLLING_INTERVAL,
    maxIntervalMs: MAX_POLLING_INTERVAL,
    isTransientError: (err) => {
      const msg = err.message ?? String(err)
      return msg.includes('SQLITE_BUSY') || msg.includes('database is locked')
    },
  })

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
      const { signal } = this.abortController!

      try {
        await setTimeout(this.breaker.getDelayWithJitter(), undefined, {
          signal,
        })
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          break
        }
        logger.error({ err }, `${this.name} sleep failed unexpectedly`)
        break
      }

      if (!this._isRunning || signal.aborted) {
        break
      }

      // Hoisted so the catch branch can emit a heartbeat for failed cycles
      // too — otherwise we lose heap/CPU/breaker visibility for the entire
      // duration of an outage, which is exactly when we need it most.
      const cpuBefore = process.cpuUsage()
      const heapBefore = process.memoryUsage().heapUsed
      const cycleStart = Date.now()

      try {
        await this.breaker.waitIfOpen(signal)

        // 1. Discover active sessions (recent keys + persisted cursors)
        const discoveryStart = Date.now()
        const recentKeys = await getRecentBubbleKeys(RECENT_DISCOVERY_LIMIT)
        const sessionIds = discoverActiveSessions(recentKeys)
        const discoveryDurationMs = Date.now() - discoveryStart

        // Group discovered keys by composerId so the worker can use a
        // fast `WHERE key IN (...)` lookup instead of a `LIKE` scan
        // per session (the slow path that was timing out in T-445).
        // Key parsing lives in rawProcessor for a single source of truth.
        const keysBySession = groupRecentKeysBySession(recentKeys)

        // Derive per-session bubble limit so total stays within MAX_RECORDS_PER_CYCLE
        const bubblesPerSession =
          sessionIds.length > 0
            ? Math.max(1, Math.floor(MAX_RECORDS_PER_CYCLE / sessionIds.length))
            : MAX_RECORDS_PER_CYCLE

        // 2. Prefetch: batch-fetch all sessions in a single worker call
        //    (connection stays open for worker lifetime, recycled between cycles)
        const prefetchStart = Date.now()
        const prefetchedSessions = await prefetchSessions(
          sessionIds.map((composerId) => ({
            composerId,
            afterRowId: getCursorRowId(composerId),
            incompleteBubbleKeys: getIncompleteBubbleKeys(composerId),
            discoveredKeys: keysBySession.get(composerId),
          })),
          bubblesPerSession
        )
        const dbPrefetchDurationMs = Date.now() - prefetchStart

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
        let uploadDurationMs: number | undefined
        if (allRecords.length > 0) {
          logger.info(
            { heartbeat: true },
            `Uploading ${allRecords.length} record(s) from ${sessionIds.length} session(s)`
          )
          const uploadStart = Date.now()
          await uploadCursorRawRecords(
            allRecords,
            allIncomplete,
            maxRowIds,
            bubblesPerSession
          )
          uploadDurationMs = Date.now() - uploadStart
        }

        // 4b. Upload new/changed context files for each active session (fire-and-forget).
        // The scanner's per-session mtime tracking skips unchanged files.
        const activeSessionIds = new Set(
          allRecords.map((r) => r.metadata.sessionId)
        )
        for (const sid of activeSessionIds) {
          uploadContextFilesForSession(sid, 'cursor').catch(() => {
            // Non-critical — already logged inside the function
          })
        }

        // 5. Update incomplete bubble lists for sessions not handled in step 4
        for (const [composerId, incomplete] of allIncomplete) {
          if (!activeSessionIds.has(composerId)) {
            updateIncompleteBubbles(
              composerId,
              incomplete,
              maxRowIds.get(composerId)
            )
          }
        }

        this.breaker.recordSuccess()

        // Emit cycle performance metrics
        const workerPerf = consumeWorkerPerf()
        logger.info(
          {
            heartbeat: true,
            data: buildCycleHeartbeat({
              cpuBefore,
              heapBefore,
              cycleStart,
              breaker: this.breaker,
              extra: {
                discoveryDurationMs,
                dbPrefetchDurationMs,
                sessionsDiscovered: sessionIds.length,
                bubblesPerSession,
                recordsProduced: allRecords.length,
                pendingSessions: prefetchedSessions.filter(
                  (s) => s.bubbles.length >= bubblesPerSession
                ).length,
                incompleteBubbles: [...allIncomplete.values()].reduce(
                  (s, a) => s + a.length,
                  0
                ),
                ...(uploadDurationMs != null && { uploadDurationMs }),
                ...(workerPerf && {
                  workerPrefetchQueryMs: workerPerf.queryDurationMs,
                  workerPrefetchHeapBytes: workerPerf.heapUsedBytes,
                  workerPrefetchRssBytes: workerPerf.rssBytes,
                  workerPrefetchRows: workerPerf.rowsReturned,
                }),
                workerAvailable: isWorkerAvailable(),
              },
            }),
          },
          'cursor poll cycle'
        )

        // Recycle worker to reset its V8 heap — works around a memory leak
        // in node:sqlite where native memory accumulates across cycles.
        try {
          await recycleWorker()
        } catch (recycleErr) {
          logger.warn({ err: recycleErr }, 'Worker recycle failed')
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          break
        }
        const failure = err instanceof Error ? err : new Error(String(err))
        this.breaker.recordFailure(failure)

        logger.info(
          {
            heartbeat: true,
            data: buildCycleHeartbeat({
              cpuBefore,
              heapBefore,
              cycleStart,
              breaker: this.breaker,
              extra: {
                cycleOutcome: 'failure',
                errorMessage: failure.message,
              },
            }),
          },
          'cursor poll cycle'
        )
      }
    }
  }
}
