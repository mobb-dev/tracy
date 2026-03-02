import Configstore from 'configstore'
import * as vscode from 'vscode'

type LogData = unknown

const MAX_LOGS_SIZE = 1000
const MAX_HEARTBEAT_SIZE = 100

type LogEntry = {
  timestamp: string
  level: string
  message: string
  durationMs?: number
  data?: LogData
}

class CircularLogger {
  private configStore: Configstore | null = null
  private workspacePath: string | null = null
  private unknownPathSuffix: string

  constructor() {
    this.unknownPathSuffix = Math.floor(1000 + Math.random() * 9000).toString()
  }

  init(): void {
    if (!this.configStore) {
      this.configStore = new Configstore('mobb-tracer-logs', {})
    }

    const folders = vscode.workspace.workspaceFolders
    if (folders && folders.length > 0) {
      const newPath = folders[0].uri.fsPath
      if (this.workspacePath !== newPath) {
        // Migrate logs from unknown path if we were using it
        if (!this.workspacePath) {
          const unknownKey = `tracer:unknown-${this.unknownPathSuffix}`
          const knownKey = `tracer:${newPath}`
          const existingLogs =
            (this.configStore.get(unknownKey) as LogEntry[]) ?? []
          if (existingLogs.length > 0) {
            const targetLogs =
              (this.configStore.get(knownKey) as LogEntry[]) ?? []
            const combined = [...targetLogs, ...existingLogs].slice(
              -MAX_LOGS_SIZE
            )
            this.configStore.set(knownKey, combined)
            this.configStore.delete(unknownKey)
          }
        }
        this.workspacePath = newPath
      }
    }
  }

  private getKey(prefix: string): string {
    if (this.workspacePath) {
      return `${prefix}:${this.workspacePath}`
    }
    return `${prefix}:unknown-${this.unknownPathSuffix}`
  }

  log(
    message: string,
    level: string = 'info',
    durationMs?: number,
    data?: LogData
  ): void {
    this.writeEntry('tracer', MAX_LOGS_SIZE, message, level, durationMs, data)
  }

  heartbeat(message: string, data?: LogData): void {
    this.writeEntry(
      'heartbeat',
      MAX_HEARTBEAT_SIZE,
      message,
      'info',
      undefined,
      data
    )
  }

  private writeEntry(
    prefix: string,
    maxSize: number,
    message: string,
    level: string,
    durationMs?: number,
    data?: LogData
  ): void {
    if (!this.configStore) {
      return
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(durationMs !== undefined && { durationMs }),
      ...(data !== undefined && { data }),
    }

    const key = this.getKey(prefix)
    const logs = (this.configStore.get(key) as LogEntry[]) ?? []
    if (logs.length >= maxSize) {
      logs.shift()
    }
    this.configStore.set(key, [...logs, entry])
  }
}

const circularLogger = new CircularLogger()

export function initCircularLog(): void {
  circularLogger.init()
}

// No-ops kept for API compatibility (extension.ts calls disposeCircularLog)
export function flushCircularLog(): void {
  // Writes are immediate — nothing to flush
}

export function disposeCircularLog(): void {
  // No timers or buffers to clean up
}

export function logInfo(message: string, data?: LogData): void {
  circularLogger.log(message, 'info', undefined, data)
}

export function logError(message: string, data?: LogData): void {
  circularLogger.log(message, 'error', undefined, data)
}

export function logWarn(message: string, data?: LogData): void {
  circularLogger.log(message, 'warn', undefined, data)
}

export function logHeartbeat(message: string, data?: LogData): void {
  circularLogger.heartbeat(message, data)
}

export async function logTimed<T>(
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  const start = Date.now()
  try {
    const result = await fn()
    const durationMs = Date.now() - start
    circularLogger.log(label, 'info', durationMs)
    return result
  } catch (err) {
    const durationMs = Date.now() - start
    circularLogger.log(
      `${label} [FAILED]`,
      'error',
      durationMs,
      err instanceof Error ? err.message : String(err)
    )
    throw err
  }
}
