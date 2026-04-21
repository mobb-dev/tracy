import path from 'node:path'
import { Worker } from 'node:worker_threads'

import type {
  ProcessedFile,
  ProcessedSkill,
} from '../mobbdev_src/features/analysis/context_file_processor'
import type {
  ContextFileEntry,
  SkillGroup,
} from '../mobbdev_src/features/analysis/context_file_scanner'
import type { WorkerResponse } from './contextFileWorkerTypes'
import { logger } from './logger'

const WORKER_TIMEOUT_MS = 60_000
/** Max consecutive rapid restarts before giving up. */
const MAX_RESTARTS = 5
/** A restart is "rapid" if it happens within this window. */
const RAPID_RESTART_WINDOW_MS = 10_000

type PendingRequest = {
  resolve: (result: {
    files: ProcessedFile[]
    skills: ProcessedSkill[]
  }) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Client for the context file worker thread.
 * Manages lifecycle and dispatches process requests via message passing.
 */
export class ContextFileWorkerClient {
  private worker: Worker | null = null
  private pending = new Map<number, PendingRequest>()
  private nextId = 1
  private disposed = false
  private restartCount = 0
  private lastRestartAt = 0

  constructor() {
    this.startWorker()
  }

  private startWorker(): void {
    const workerPath = path.join(__dirname, 'contextFileWorker.js')
    const w = new Worker(workerPath)
    this.worker = w

    w.on('message', (response: WorkerResponse) => {
      if (response.id === -1) {
        logger.error(
          { err: response.error },
          'Context file worker unhandled rejection'
        )
        return
      }
      const pending = this.pending.get(response.id)
      if (!pending) {
        return
      }
      this.pending.delete(response.id)
      clearTimeout(pending.timer)

      if (response.error) {
        pending.reject(new Error(response.error))
      } else if (response.result) {
        // Reconstruct Buffer from transferred ArrayBuffer (zero-copy hand-off)
        const skills: ProcessedSkill[] = response.result.skills.map((s) => ({
          ...s,
          zipBuffer: Buffer.from(s.zipBuffer),
        }))
        pending.resolve({ files: response.result.files, skills })
      } else {
        pending.reject(new Error('Worker returned empty result'))
      }
    })

    w.on('error', (err: unknown) => {
      if (this.disposed) {
        return
      }
      logger.error({ err }, 'Context file worker error — restarting')
      this.rejectAll(err instanceof Error ? err : new Error(String(err)))
      this.maybeRestart()
    })

    w.on('exit', (code) => {
      if (this.disposed) {
        return
      }
      if (code !== 0) {
        const err = new Error(`Context file worker exited with code ${code}`)
        logger.warn(
          { code },
          'Context file worker exited unexpectedly — restarting'
        )
        this.rejectAll(err)
        this.maybeRestart()
      } else {
        // Clean exit with pending requests — reject them so callers don't hang
        if (this.pending.size > 0) {
          this.rejectAll(new Error('Context file worker exited unexpectedly'))
        }
      }
    })
  }

  private maybeRestart(): void {
    const now = Date.now()
    if (now - this.lastRestartAt < RAPID_RESTART_WINDOW_MS) {
      this.restartCount++
    } else {
      this.restartCount = 1
    }
    this.lastRestartAt = now

    if (this.restartCount > MAX_RESTARTS) {
      logger.error(
        { restartCount: this.restartCount },
        'Context file worker exceeded max restarts — giving up'
      )
      this.rejectAll(
        new Error('Context file worker exceeded max restart limit')
      )
      return
    }

    const backoffMs = Math.min(1000 * 2 ** (this.restartCount - 1), 30_000)
    logger.warn(
      { restartCount: this.restartCount, backoffMs },
      'Scheduling context file worker restart'
    )
    setTimeout(() => {
      if (!this.disposed) {
        try {
          this.startWorker()
        } catch (err) {
          logger.error({ err }, 'Failed to restart context file worker')
        }
      }
    }, backoffMs)
  }

  private rejectAll(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pending.clear()
  }

  async process(
    files: ContextFileEntry[],
    skillGroups: SkillGroup[]
  ): Promise<{ files: ProcessedFile[]; skills: ProcessedSkill[] }> {
    if (!this.worker) {
      throw new Error('Context file worker is not running')
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new Error(
            `Context file worker timed out after ${WORKER_TIMEOUT_MS}ms`
          )
        )
      }, WORKER_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.worker!.postMessage({ id, files, skillGroups })
    })
  }

  dispose(): void {
    this.disposed = true
    this.rejectAll(new Error('ContextFileWorkerClient disposed'))
    this.worker?.terminate()
    this.worker = null
  }
}
