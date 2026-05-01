import * as crypto from 'node:crypto'
import * as path from 'node:path'
import { setTimeout } from 'node:timers/promises'

import * as vscode from 'vscode'

import {
  EditType,
  InferencePlatform,
} from '../mobbdev_src/features/analysis/scm/generates/client_generates'
import { CircuitBreaker } from '../shared/CircuitBreaker'
import { getConfig } from '../shared/config'
import { BaseMonitor } from '../shared/IMonitor'
import { logger } from '../shared/logger'
import { buildCycleHeartbeat, machineContext } from '../shared/machineContext'
import { AppType, getNormalizedRepoUrl } from '../shared/repositoryInfo'
import {
  uploadContextFilesForSession,
  uploadCopilotRawRecords,
  uploadTracyRecords,
} from '../shared/uploader'
import { LogContextRecord } from './events/LogContextRecord'
import { LogContextWatcher } from './logContextWatcher'
import {
  advanceCursor,
  cleanupStaleCursors,
  type CopilotRawRecord,
  createEmptyState,
  discoverActiveSessionFiles,
  getStoredByteOffset,
  processLines,
  readSessionId,
  type SessionFileState,
} from './rawProcessor'
import {
  closeReadWorker,
  consumeReadWorkerPerf,
  initReadWorker,
  readNewLinesBatch,
} from './readClient'

const DEFAULT_POLLING_INTERVAL = 20_000
const BASE_POLLING_INTERVAL = process.env.MOBB_TRACER_POLL_INTERVAL_MS
  ? Number(process.env.MOBB_TRACER_POLL_INTERVAL_MS)
  : DEFAULT_POLLING_INTERVAL
const MAX_POLLING_INTERVAL = BASE_POLLING_INTERVAL * 6
const MAX_RECORDS_PER_CYCLE = 200
/**
 * Cap files read per cycle to bound blocking on the extension host thread.
 * Without this, a first-run catch-up (no persisted cursors) can discover
 * dozens of historical JSONL files and read them all in parallel — a single
 * 17s blocking cycle + ~180MB heap spike was observed in the B3 stress test.
 *
 * Files are sorted mtime-DESC in `discoverActiveSessionFiles`, so the freshest
 * activity always gets processed first. Remaining files get picked up on
 * subsequent cycles (20s later), spreading the catch-up over several minutes
 * instead of hanging the IDE in one burst.
 */
const MAX_SESSION_FILES_PER_CYCLE = 10
const SESSION_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 1 week

/**
 * Yield control to the extension host event loop for one tick.
 *
 * `setImmediate` runs after all currently-queued I/O callbacks, giving the
 * event loop a chance to render a frame or handle user input before we
 * charge into the next file's sync processing. Cost is on the order of
 * tens of microseconds — negligible compared to even the fastest
 * `processLines` call.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export class CopilotMonitor extends BaseMonitor {
  readonly name = 'CopilotMonitor'

  private pollingPromise: Promise<void> | null = null
  private abortController: AbortController | null = null
  private breaker = new CircuitBreaker({
    name: 'CopilotMonitor',
    threshold: 5,
    cooldownMs: 120_000,
    baseIntervalMs: BASE_POLLING_INTERVAL,
    maxIntervalMs: MAX_POLLING_INTERVAL,
    isTransientError: (err) => {
      const msg = err.message ?? String(err)
      return msg.includes('EBUSY') || msg.includes('EACCES')
    },
  })

  /** In-memory state per session file (rebuilt from byte 0 on restart) */
  private sessionStates = new Map<string, SessionFileState>()
  /** Track last activity per session file for eviction */
  private sessionLastSeen = new Map<string, number>()

  /** LogContextWatcher for inline edits (separate from chat) */
  private logContextWatcher: LogContextWatcher | null = null

  /** Workspace storage path — scoped to this VS Code window.
   *  Derived from context.storageUri which is unique per workspace. */
  private workspaceStoragePath: string | undefined

  constructor(
    private context: vscode.ExtensionContext,
    appType: AppType
  ) {
    super(appType)
    // context.storageUri = workspaceStorage/{hash}/extensionId
    // Go up one level to get workspaceStorage/{hash}
    if (context.storageUri) {
      this.workspaceStoragePath = path.dirname(context.storageUri.fsPath)
    }
  }

  private isCopilotInstalled(): boolean {
    const copilotExtension = vscode.extensions.getExtension('github.copilot')
    const copilotChatExtension = vscode.extensions.getExtension(
      'github.copilot-chat'
    )
    if (!copilotExtension && !copilotChatExtension) {
      logger.info(
        'GitHub Copilot extension not installed - CopilotMonitor will not start'
      )
      return false
    }
    logger.debug('GitHub Copilot extension detected', {
      copilot: copilotExtension?.id,
      copilotChat: copilotChatExtension?.id,
    })
    return true
  }

  async start(): Promise<void> {
    if (this._isRunning) {
      logger.debug(`${this.name} is already running`)
      return
    }

    if (!this.isCopilotInstalled()) {
      return
    }

    logger.debug(`Starting ${this.name}`)

    // Clean up stale cursor keys from configStore on startup
    cleanupStaleCursors()

    // Spin up the dedicated JSONL-read worker before the poll loop starts.
    // Keeps multi-MB file reads + UTF-8 decoding off the extension host
    // thread; falls back gracefully if the worker fails to spawn.
    await initReadWorker()

    logger.info(
      `CopilotMonitor: workspace storage = ${this.workspaceStoragePath ?? 'ALL (no storageUri)'}`
    )

    // Start LogContextWatcher for inline edits (kept from old monitor)
    this.logContextWatcher = new LogContextWatcher(this.context, {
      onLogContextRecord: this.handleLogContextRecord.bind(this),
    })
    const logContextStarted = await this.logContextWatcher.start()
    if (logContextStarted) {
      logger.debug(
        `LogContextWatcher started, watching: ${this.logContextWatcher.getLogPath()}`
      )
    }

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

    if (this.logContextWatcher) {
      this.logContextWatcher.stop()
      this.logContextWatcher = null
    }

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

    // Tear down the read worker after the poll loop has exited so no
    // in-flight request ends up talking to a terminated thread.
    try {
      await closeReadWorker()
    } catch (err) {
      logger.warn({ err }, 'Error closing Copilot read worker')
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
        // 1. Discover files with new data (cheap: stat + ConfigStore comparison)
        const allDiscovered = await discoverActiveSessionFiles(
          this.workspaceStoragePath
        )

        // Cap files processed per cycle. Files are pre-sorted mtime-DESC, so
        // the freshest sessions always go first; older ones drain over later
        // cycles. See MAX_SESSION_FILES_PER_CYCLE comment for rationale.
        const sessionFiles = allDiscovered.slice(0, MAX_SESSION_FILES_PER_CYCLE)
        const deferredCount = allDiscovered.length - sessionFiles.length

        // Derive per-file record limit so total stays within MAX_RECORDS_PER_CYCLE
        const recordsPerFile =
          sessionFiles.length > 0
            ? Math.max(
                1,
                Math.floor(MAX_RECORDS_PER_CYCLE / sessionFiles.length)
              )
            : MAX_RECORDS_PER_CYCLE

        // 2. Prefetch: read new lines from all files via the read worker.
        // The worker parallelizes fs.read + utf-8 decode + line split off the
        // extension host main thread. Main-thread work here is only the
        // configstore lookup for each file's persisted byteOffset.
        const readRequests = sessionFiles.map((f) => ({
          path: f.path,
          byteOffset: getStoredByteOffset(f.path),
        }))
        const prefetched = await readNewLinesBatch(readRequests)
        // Graceful degradation: if the worker is down (returned []), record
        // a transient failure so the breaker tracks it and the heartbeat
        // stays visible in DD. Without this, a stuck worker creates an
        // invisible infinite skip loop (Finding 5).
        if (prefetched.length !== sessionFiles.length) {
          this.breaker.recordFailure(
            new Error('Read worker unavailable or partial response')
          )
          logger.warn(
            {
              heartbeat: true,
              data: {
                requested: sessionFiles.length,
                received: prefetched.length,
                cycleOutcome: 'workerUnavailable',
                breakerFailures: this.breaker.failures,
                breakerIntervalMs: this.breaker.currentInterval,
                ...machineContext,
              },
            },
            'Read worker unavailable or partial response — skipping cycle'
          )
          continue
        }
        // File handles are closed — all subsequent work is in-memory

        // Log per-file read errors so they're visible in DD (Finding 8).
        // Files with errors still return empty lines — they just won't
        // produce records this cycle and will be retried next poll.
        for (const result of prefetched) {
          if (result.error) {
            logger.warn(
              { filePath: result.path, error: result.error },
              'Copilot session file read error'
            )
          }
        }

        // 3. Process: build state + extract completed requests (minimal I/O: sessionId recovery only)
        const now = Date.now()
        const allRecords: CopilotRawRecord[] = []
        const allEmittedIds: { state: SessionFileState; ids: string[] }[] = []
        for (let i = 0; i < sessionFiles.length; i++) {
          const filePath = sessionFiles[i].path
          this.sessionLastSeen.set(filePath, now)
          const state = this.sessionStates.get(filePath) ?? createEmptyState()
          // After restart: in-memory state is empty but cursor is advanced past kind:0.
          // Re-read the first line to recover sessionId.
          if (!state.sessionId) {
            state.sessionId = await readSessionId(filePath)
          }
          const { records, emittedIds } = await processLines(
            prefetched[i].lines,
            state,
            recordsPerFile
          )
          this.sessionStates.set(filePath, state)
          allRecords.push(...records)
          if (emittedIds.length > 0) {
            allEmittedIds.push({ state, ids: emittedIds })
          }
          // Yield to the event loop after each file so a large catch-up
          // batch doesn't monopolize the extension host. No-op for tiny
          // sessions; prevents multi-file first-run blocks from feeling
          // like a freeze even on fast SSDs.
          await yieldToEventLoop()
        }

        // 4. Upload records if any, then advance all cursors
        let uploadDurationMs: number | undefined
        if (allRecords.length > 0) {
          const uploadStart = Date.now()
          await uploadCopilotRawRecords(allRecords)
          uploadDurationMs = Date.now() - uploadStart
          // Commit emitted IDs only after successful upload
          for (const { state, ids } of allEmittedIds) {
            for (const id of ids) {
              state.uploadedRequestIds.add(id)
            }
          }
          logger.info(
            { heartbeat: true },
            `Uploaded ${allRecords.length} record(s) from ${sessionFiles.length} file(s)`
          )

          // Upload new/changed context files for each active session (fire-and-forget).
          // The scanner's per-session mtime tracking skips unchanged files.
          const activeSessionIds = new Set(
            allRecords
              .map((r) => r.metadata?.sessionId)
              .filter((s): s is string => !!s)
          )
          for (const sid of activeSessionIds) {
            uploadContextFilesForSession(sid, 'copilot').catch(() => {
              // Non-critical — already logged inside the function
            })
          }
        }

        // Advance cursors for ALL read files — even those with 0 records.
        // Prevents re-reading the same lines when no new completed requests exist.
        for (let i = 0; i < sessionFiles.length; i++) {
          if (prefetched[i].lines.length > 0) {
            advanceCursor(
              sessionFiles[i].path,
              prefetched[i].newByteOffset,
              prefetched[i].newFileSize
            )
          }
        }

        // Evict stale session states (not seen for 1 week)
        const staleKeys = [...this.sessionLastSeen.entries()]
          .filter(([, lastSeen]) => now - lastSeen > SESSION_STATE_MAX_AGE_MS)
          .map(([filePath]) => filePath)
        for (const filePath of staleKeys) {
          this.sessionStates.delete(filePath)
          this.sessionLastSeen.delete(filePath)
        }

        this.breaker.recordSuccess()

        // Compute monitoring metrics
        const totalCharsRead = prefetched.reduce(
          (sum, p) => sum + p.lines.reduce((s, l) => s + l.length, 0),
          0
        )
        let pendingRequests = 0
        for (const state of this.sessionStates.values()) {
          pendingRequests +=
            state.requestData.size - state.uploadedRequestIds.size
        }

        // Emit cycle performance metrics
        const readPerf = consumeReadWorkerPerf()
        logger.info(
          {
            heartbeat: true,
            data: buildCycleHeartbeat({
              cpuBefore,
              heapBefore,
              cycleStart,
              breaker: this.breaker,
              extra: {
                filesDiscovered: sessionFiles.length,
                filesDeferred: deferredCount,
                ...(readPerf && {
                  readWorkerDurationMs: readPerf.queryDurationMs,
                  readWorkerHeapUsedBytes: readPerf.heapUsedBytes,
                  readWorkerRssBytes: readPerf.rssBytes,
                }),
                recordsPerFile,
                recordsProduced: allRecords.length,
                totalCharsRead,
                pendingRequests,
                trackedSessions: this.sessionStates.size,
                evictedSessions: staleKeys.length,
                ...(uploadDurationMs != null && { uploadDurationMs }),
              },
            }),
          },
          'copilot poll cycle'
        )
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
                pendingRequests: [...this.sessionStates.values()].reduce(
                  (n, s) =>
                    n + (s.requestData.size - s.uploadedRequestIds.size),
                  0
                ),
                trackedSessions: this.sessionStates.size,
              },
            }),
          },
          'copilot poll cycle'
        )
      }
    }
  }

  /** Handle inline edit records from LogContextWatcher */
  private async handleLogContextRecord(
    record: LogContextRecord
  ): Promise<void> {
    logger.debug(
      `LogContext: received record ${record.event.requestId} for ${record.event.filePath}`
    )

    const addedLines = record.computeAddedLines()
    if (addedLines.length > 0 && record.event.isAccepted) {
      const repositoryUrl = await getNormalizedRepoUrl(record.event.filePath)
      await uploadTracyRecords([
        {
          platform: InferencePlatform.Copilot,
          recordId: crypto.randomUUID(),
          recordTimestamp: new Date().toISOString(),
          editType: EditType.TabAutocomplete,
          additions: addedLines.join('\n'),
          filePath: record.event.filePath,
          repositoryUrl: repositoryUrl ?? undefined,
          clientVersion: getConfig().extensionVersion,
        },
      ])
    }
  }
}
