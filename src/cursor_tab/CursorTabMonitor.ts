import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { join } from 'node:path'

import * as vscode from 'vscode'

import { AiBlameInferenceType } from '../mobbdev_src/features/analysis/scm/generates/client_generates'
import { BaseMonitor } from '../shared/IMonitor'
import { logger } from '../shared/logger'
import { AppType } from '../shared/repositoryInfo'
import { uploadCursorChanges } from '../shared/uploader'
import { AcceptanceTracker } from './AcceptanceTracker'

export class CursorTabMonitor extends BaseMonitor {
  readonly name = 'CursorTabMonitor'
  private acceptanceTracker: AcceptanceTracker | undefined
  private activeEditorUri: string | undefined
  private editorChangeDisposable: vscode.Disposable | undefined

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
      // Initialize acceptance tracker with upload callback
      this.acceptanceTracker = new AcceptanceTracker((additions) => {
        this.uploadAcceptedCompletion(additions)
      })

      // Track active editor for document URI
      this.activeEditorUri =
        vscode.window.activeTextEditor?.document.uri.toString()
      this.editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(
        (editor) => {
          this.activeEditorUri = editor?.document.uri.toString()
        }
      )

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

    this.acceptanceTracker?.dispose()
    this.acceptanceTracker = undefined

    this.editorChangeDisposable?.dispose()
    this.editorChangeDisposable = undefined

    this._isRunning = false
    logger.info(`${this.name} stopped`)
  }

  private processLogEntries(content: string): void {
    const lines = content.split('\n').filter((line) => line.trim())

    // First pass: collect removed and added lines
    const removedLines = new Set<string>()
    const addedLines: string[] = []

    for (const line of lines) {
      if (line.startsWith('-|')) {
        removedLines.add(line.substring(2))
      } else if (line.startsWith('+|')) {
        addedLines.push(line.substring(2))
      }
    }

    // Second pass: filter out added lines that are identical to removed lines (human-written)
    const aiGeneratedAdditions = addedLines.filter(
      (line) => !removedLines.has(line)
    )

    const additions = aiGeneratedAdditions.join('\n').trim()

    if (additions.length === 0) {
      logger.info(`Cursor tab additions are empty`)
      return
    }

    if (additions.length < 30) {
      logger.info(`Cursor tab additions are smaller than 30. Ignore tracking`)
      return
    }

    if (!this.activeEditorUri) {
      logger.info(`No active editor, cannot track completion acceptance`)
      return
    }

    logger.info(`Cursor tab additions: ${additions.slice(0, 100)}...`)

    // Track as pending instead of immediate upload
    this.acceptanceTracker?.trackPendingCompletion(
      additions,
      this.activeEditorUri
    )
  }

  private uploadAcceptedCompletion(additions: string): void {
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
