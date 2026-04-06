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
import { AppType, getNormalizedRepoUrl } from '../shared/repositoryInfo'
import { uploadCopilotRawRecords, uploadTracyRecords } from '../shared/uploader'
import { LogContextRecord } from './events/LogContextRecord'
import { LogContextWatcher } from './logContextWatcher'
import {
  advanceCursor,
  cleanupStaleCursors,
  type CopilotRawRecord,
  createEmptyState,
  discoverActiveSessionFiles,
  processLines,
  readNewLines,
  readSessionId,
  type SessionFileState,
} from './rawProcessor'

const DEFAULT_POLLING_INTERVAL = 20_000
const BASE_POLLING_INTERVAL = process.env.MOBB_TRACER_POLL_INTERVAL_MS
  ? Number(process.env.MOBB_TRACER_POLL_INTERVAL_MS)
  : DEFAULT_POLLING_INTERVAL
const MAX_POLLING_INTERVAL = BASE_POLLING_INTERVAL * 6
const MAX_RECORDS_PER_CYCLE = 200
const SESSION_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 1 week

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

      try {
        await this.breaker.waitIfOpen(signal)
        // 1. Discover files with new data (cheap: stat + ConfigStore comparison)
        const sessionFiles = await discoverActiveSessionFiles(
          this.workspaceStoragePath
        )

        // Derive per-file record limit so total stays within MAX_RECORDS_PER_CYCLE
        const recordsPerFile =
          sessionFiles.length > 0
            ? Math.max(
                1,
                Math.floor(MAX_RECORDS_PER_CYCLE / sessionFiles.length)
              )
            : MAX_RECORDS_PER_CYCLE

        // 2. Prefetch: read new lines from all files (parallelized I/O)
        const prefetched = await Promise.all(
          sessionFiles.map((f) => readNewLines(f.path))
        )
        // File handles are closed — all subsequent work is in-memory

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
          const { records, emittedIds } = processLines(
            prefetched[i].lines,
            state,
            recordsPerFile
          )
          this.sessionStates.set(filePath, state)
          allRecords.push(...records)
          if (emittedIds.length > 0) {
            allEmittedIds.push({ state, ids: emittedIds })
          }
        }

        // 4. Upload records if any, then advance all cursors
        if (allRecords.length > 0) {
          await uploadCopilotRawRecords(allRecords)
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
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          break
        }
        this.breaker.recordFailure(
          err instanceof Error ? err : new Error(String(err))
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
