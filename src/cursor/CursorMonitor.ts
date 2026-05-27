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
  fetchComposerContent,
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
  getIncompleteBubbleMap,
  groupRecentKeysBySession,
  prepareSessionForUpload,
  revisitIncompleteBubbles,
  updateIncompleteBubbles,
} from './rawProcessor'
import { attachResolvedContent } from './resolveContent'

const DEFAULT_POLLING_INTERVAL = 20_000
const BASE_POLLING_INTERVAL = process.env.MOBB_TRACER_POLL_INTERVAL_MS
  ? Number(process.env.MOBB_TRACER_POLL_INTERVAL_MS)
  : DEFAULT_POLLING_INTERVAL
const MAX_POLLING_INTERVAL = BASE_POLLING_INTERVAL * 6
const RECENT_DISCOVERY_LIMIT = 500
const MAX_RECORDS_PER_CYCLE = 200
// Cap how many cycles a record can be re-queued for resolve-failure before
// we give up and ship it via the legacy (unresolved) path. Two cycles ≈ 40s
// of busy_timeout-bounded SQLite contention slack at the 20s poll interval —
// enough to ride out a transient Cursor write burst, while guaranteeing
// uploads never stall forever on sustained contention. The backend's
// regression log (`edit_file_v2 new-format payload produced no extractable
// content`) makes the fallback visible in Datadog. See T-516 deeper-flake fix.
const MAX_RESOLVE_ATTEMPTS = 2

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
          { key: string; firstSeenAt: number; resolveAttempts?: number }[]
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

        // 3b. Resolve content-by-reference for edit_file_v2 bubbles before
        // upload. Mutates records in place; never throws. Records that
        // can't be resolved on the happy path (missing row, oversize) ship
        // unchanged — backend's legacy path runs and the regression log
        // fires if appropriate. Records that fail because of a transient
        // worker error (SQLITE_BUSY, recycle) are re-queued via
        // incompleteBubbles so the next cycle retries them, instead of
        // letting the cursor advance past them with null content. See
        // T-516 review Finding 1.
        //
        // Invariant: nothing between `attachResolvedContent` and
        // `uploadCursorRawRecords` may `await` on anything that reads
        // `allRecords` from another context. The resolved-content fields
        // are attached in-place; an interleaved reader would see a
        // half-mutated set. See T-516 review Finding 17 (TOCTOU). If a
        // future step lands between resolve and upload that also needs
        // record state, switch `attachResolvedContent` to return new
        // records rather than mutating.
        let recordsToUpload = allRecords
        if (allRecords.length > 0) {
          const { failed } = await attachResolvedContent(
            allRecords,
            fetchComposerContent
          )
          if (failed.length > 0) {
            const reQueuedAt = Date.now()
            // Read prior IncompleteBubble entries per session once. Preserves
            // `firstSeenAt` (so STALE_KEY_MAX_AGE_MS eviction can fire on
            // pathological rows) and `resolveAttempts` (so we can fall back
            // to the legacy upload path after MAX_RESOLVE_ATTEMPTS rather
            // than blocking uploads forever on sustained contention).
            const priorBySession = new Map<
              string,
              Map<string, { firstSeenAt: number; resolveAttempts?: number }>
            >()
            const blockedRecordIds = new Set<string>()
            let fellBack = 0
            for (const f of failed) {
              if (!priorBySession.has(f.sessionId)) {
                priorBySession.set(
                  f.sessionId,
                  getIncompleteBubbleMap(f.sessionId)
                )
              }
              const sqliteKey = `bubbleId:${f.sessionId}:${f.recordId}`
              const prior = priorBySession.get(f.sessionId)?.get(sqliteKey)
              const priorAttempts = prior?.resolveAttempts ?? 0
              const nextAttempts = priorAttempts + 1
              if (priorAttempts >= MAX_RESOLVE_ATTEMPTS) {
                // Budget exhausted — ship via the legacy (unresolved) path.
                // The backend's regression log will fire and Datadog will
                // surface that the record was attribution-blind. Better than
                // an indefinite upload outage.
                fellBack++
                continue
              }
              blockedRecordIds.add(f.recordId)
              const list = allIncomplete.get(f.sessionId) ?? []
              list.push({
                key: sqliteKey,
                firstSeenAt: prior?.firstSeenAt ?? reQueuedAt,
                resolveAttempts: nextAttempts,
              })
              allIncomplete.set(f.sessionId, list)
            }
            if (blockedRecordIds.size > 0) {
              recordsToUpload = allRecords.filter(
                (r) => !blockedRecordIds.has(r.metadata.recordId)
              )
            }
            logger.warn(
              {
                failedRecords: failed.length,
                reQueued: blockedRecordIds.size,
                shippedUnresolved: fellBack,
                retainedRecords: recordsToUpload.length,
              },
              fellBack > 0
                ? 'Resolve-failure budget exhausted for some records — shipping unresolved (backend regression log will fire)'
                : 'Re-queued edit_file_v2 records for next-cycle retry after resolve failure'
            )
          }
        }

        // 4. Upload all records in a single batch
        let uploadDurationMs: number | undefined
        if (recordsToUpload.length > 0) {
          logger.info(
            { heartbeat: true },
            `Uploading ${recordsToUpload.length} record(s) from ${sessionIds.length} session(s)`
          )
          const uploadStart = Date.now()
          await uploadCursorRawRecords(
            recordsToUpload,
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
