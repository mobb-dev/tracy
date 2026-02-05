import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as vscode from 'vscode'

import { logJsonToFile } from '../shared/fileLogger'
import { logger } from '../shared/logger'
import { LogContextRecord } from './events/LogContextRecord'

export type LogContextWatcherOptions = {
  /** Callback when a new log context record is detected */
  onLogContextRecord?: (record: LogContextRecord) => void | Promise<void>
}

/**
 * Watches the Copilot log context recordings file and parses new records as they are appended.
 * Safely resolves the file path for different users and handles missing files gracefully.
 */
export class LogContextWatcher {
  private readonly opt: LogContextWatcherOptions
  private watcher?: fs.FSWatcher
  private logFilePath?: string
  private lastFileSize = 0
  private isWatching = false

  constructor(
    private ctx: vscode.ExtensionContext,
    opt?: LogContextWatcherOptions
  ) {
    this.opt = opt ?? {}
  }

  /**
   * Safely resolves the Copilot log context file path for the current user
   */
  private resolveLogContextPath(): string | undefined {
    try {
      const homeDir = os.homedir()
      if (!homeDir) {
        logger.warn('Could not determine user home directory')
        return undefined
      }

      // Different paths for different platforms
      let basePath: string
      switch (os.platform()) {
        case 'darwin': // macOS
          basePath = path.join(homeDir, 'Library', 'Application Support')
          break
        case 'win32': // Windows
          basePath =
            process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming')
          break
        case 'linux': // Linux
          basePath =
            process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config')
          break
        default:
          logger.warn(`Unsupported platform: ${os.platform()}`)
          return undefined
      }

      const logPath = path.join(
        basePath,
        'Code',
        'User',
        'globalStorage',
        'github.copilot-chat',
        'logContextRecordings',
        'current.logContext.jsonl'
      )

      // Check if file exists
      if (!fs.existsSync(logPath)) {
        logger.debug(`Log context file does not exist: ${logPath}`)
        return undefined
      }

      logger.debug(`Found log context file: ${logPath}`)
      return logPath
    } catch (err) {
      logger.error({ err }, 'Failed to resolve log context path')
      return undefined
    }
  }

  /**
   * Starts watching the log context file
   */
  async start(): Promise<boolean> {
    if (this.isWatching) {
      logger.warn('LogContextWatcher is already running')
      return false
    }

    this.logFilePath = this.resolveLogContextPath()
    if (!this.logFilePath) {
      logger.warn(
        'Could not resolve log context file path - watcher will not start'
      )
      return false
    }

    try {
      // Get initial file size
      const stats = fs.statSync(this.logFilePath)
      this.lastFileSize = stats.size

      // Create file watcher
      this.watcher = fs.watch(
        this.logFilePath,
        { persistent: false },
        (eventType) => {
          if (eventType === 'change') {
            this.handleFileChange().catch((err) => {
              logger.error({ err }, 'Error handling log context file change')
            })
          }
        }
      )

      this.watcher.on('error', (err) => {
        logger.error({ err }, 'Log context file watcher error')
        this.stop()
      })

      // Add to extension subscriptions for cleanup
      this.ctx.subscriptions.push({
        dispose: () => this.stop(),
      })

      this.isWatching = true
      logger.debug(`Started watching log context file: ${this.logFilePath}`)
      return true
    } catch (err) {
      logger.error({ err }, 'Failed to start log context watcher')
      return false
    }
  }

  /**
   * Stops watching the log context file
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = undefined
    }
    this.isWatching = false
    logger.debug('Stopped log context watcher')
  }

  /**
   * Handles file changes by reading new content and parsing log context records
   */
  private async handleFileChange(): Promise<void> {
    if (!this.logFilePath) {
      return
    }

    try {
      const stats = fs.statSync(this.logFilePath)
      const currentSize = stats.size

      // Only process if file has grown (new content appended)
      if (currentSize <= this.lastFileSize) {
        return
      }

      // Read only the new content
      const stream = fs.createReadStream(this.logFilePath, {
        start: this.lastFileSize,
        end: currentSize - 1,
        encoding: 'utf8',
      })

      let buffer = ''
      stream.on('data', (chunk: string) => {
        buffer += chunk
      })

      stream.on('end', () => {
        this.processNewContent(buffer)
        this.lastFileSize = currentSize
      })

      stream.on('error', (err) => {
        logger.error({ err }, 'Error reading log context file')
      })
    } catch (err) {
      logger.error({ err }, 'Error handling log context file change')
    }
  }

  /**
   * Processes new content from the log file and extracts log context records
   */
  private processNewContent(content: string): void {
    if (!content.trim()) {
      return
    }

    // Split by lines and process each JSON line
    const lines = content.split('\n').filter((line) => line.trim())

    for (const line of lines) {
      try {
        const record = LogContextRecord.fromJson(line)
        logger.debug(`Parsed log context record: ${record.event.requestId}`)

        // Log to disk for inspection
        logJsonToFile(
          record.event,
          `logContext_${record.event.requestId}`,
          'logContext'
        ).catch((err) => {
          logger.warn({ err }, 'Failed to log context record to file')
        })

        // Dispatch to handler
        try {
          const result = this.opt.onLogContextRecord?.(record)
          if (result instanceof Promise) {
            result.catch((err) => {
              logger.warn({ err }, 'Error in log context record handler')
            })
          }
        } catch (err) {
          logger.warn({ err }, 'Error in log context record handler')
        }
      } catch (err) {
        logger.warn(
          {
            err,
            problematicLine: `${line.substring(0, 200)}...`,
          },
          'Failed to parse log context record'
        )
      }
    }
  }

  /**
   * Check if the watcher is currently active
   */
  isActive(): boolean {
    return this.isWatching
  }

  /**
   * Get the current log file path being watched
   */
  getLogPath(): string | undefined {
    return this.logFilePath
  }
}
