import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { join } from 'node:path'

import * as vscode from 'vscode'

import { AiBlameInferenceType } from '../mobbdev_src/features/analysis/scm/generates/client_generates'
import { BaseMonitor } from '../shared/IMonitor'
import { logger } from '../shared/logger'
import { AppType } from '../shared/repositoryInfo'
import { uploadCursorChanges } from '../shared/uploader'

export class CursorTabMonitor extends BaseMonitor {
  readonly name = 'CursorTabMonitor'

  constructor(
    private context: vscode.ExtensionContext,
    appType: AppType,
    private fsWatchInterval = 1000
  ) {
    super(appType)
  }

  async start(): Promise<void> {
    if (this._isRunning) {
      logger.info(`${this.name} is already running`)
      return
    }

    logger.info(`Starting ${this.name}`)

    try {
      //cursor uses an old vscode engine so we must use an old deprecated API
      const logPath = join(
        this.context.logPath,
        '../anysphere.cursor-always-local/Cursor Tab.log'
      )
      let lastSize = 0

      if (fs.existsSync(logPath)) {
        const stats = await fsPromises.stat(logPath)
        lastSize = stats.size
      }

      fs.watchFile(
        logPath,
        { interval: this.fsWatchInterval },
        (curr, prev) => {
          // This should never happen in normal circumstances - log files
          // should only grow forward.
          if (curr.mtime < prev.mtime || curr.size <= lastSize) {
            logger.warn(
              'Unexpected log file state: mtime regression or size not increasing'
            )
            return
          }

          const stream = fs.createReadStream(logPath, {
            start: lastSize,
            end: curr.size - 1,
          })

          let newContent = ''

          stream.on('data', (chunk) => {
            newContent += chunk.toString()
          })

          stream.on('end', () => {
            this.processLogEntries(newContent)
            lastSize = curr.size
          })

          stream.on('error', (err) => {
            logger.error({ err }, 'Error reading cursor tab log file')
          })
        }
      )

      this._isRunning = true
      logger.info(`${this.name} started successfully`)
    } catch (err) {
      logger.error({ err }, `Failed to start ${this.name}`)
      this._isRunning = false
      throw err
    }
  }

  async stop(): Promise<void> {
    if (!this._isRunning) {
      return
    }

    logger.info(`Stopping ${this.name}`)
    const logPath = join(
      this.context.logPath,
      '../anysphere.cursor-always-local/Cursor Tab.log'
    )
    fs.unwatchFile(logPath)
    this._isRunning = false
    logger.info(`${this.name} stopped`)
  }

  private processLogEntries(content: string): void {
    const lines = content.split('\n').filter((line) => line.trim())
    let additions = ''

    for (const line of lines) {
      if (line.startsWith('+|')) {
        const addition = line.substring(2)
        additions += `${addition}\n`
      }
    }

    additions = additions.trim()

    if (additions.length === 0) {
      logger.info(`Cursor tab additions are empty`)
      return
    }

    if (additions.length < 30) {
      logger.info(`Cursor tab additions are smaller than 30. Ignore uploading`)
      return
    }

    logger.info(`Cursor tab additions: ${additions.slice(0, 100)}...`)

    uploadCursorChanges([
      {
        additions,
        createdAt: new Date(),
        model: 'Cursor Tab Autocomplete',
        conversation: [],
        type: AiBlameInferenceType.TabAutocomplete,
      },
    ]).catch((err) => {
      logger.error({ err }, 'Cursor tab upload failed')
    })
  }
}
