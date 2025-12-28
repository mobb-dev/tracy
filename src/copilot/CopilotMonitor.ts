import * as vscode from 'vscode'

import { AiBlameInferenceType } from '../mobbdev_src/features/analysis/scm/generates/client_generates'
import { initFileLogger } from '../shared/fileLogger'
import { BaseMonitor } from '../shared/IMonitor'
import { logger } from '../shared/logger'
import { AppType } from '../shared/repositoryInfo'
import { uploadCopilotChanges } from '../shared/uploader'
import { CopilotCcreqWatcher } from './copilotCcreqWatcher'
import { ChatMLSuccess, EDIT_TOOLS, ToolCall } from './events'
import { LogContextRecord } from './events/LogContextRecord'
import { LogContextWatcher } from './logContextWatcher'
import { SnapshotTracker } from './snapshotTracker'
import { makeStableId } from './utils/ids'

export class CopilotMonitor extends BaseMonitor {
  readonly name = 'CopilotMonitor'

  private inferenceMap = new Map<string, string>()
  private recordedContextIds = new Set<string>()
  private snapshot: SnapshotTracker
  private watcher: CopilotCcreqWatcher | null = null
  private logContextWatcher: LogContextWatcher | null = null

  constructor(
    private context: vscode.ExtensionContext,
    appType: AppType
  ) {
    super(appType)
    this.snapshot = new SnapshotTracker()
  }

  async start(): Promise<void> {
    if (this._isRunning) {
      logger.info(`${this.name} is already running`)
      return
    }

    logger.info(`Starting ${this.name}`)

    try {
      // Initialize logging
      initFileLogger(this.context)
      // Optional: enable workspace edit tracing (harmless if not present)
      await vscode.commands
        .executeCommand('github.copilot.chat.replay.enableWorkspaceEditTracing')
        .then(
          () => logger.debug('Enabled workspace edit tracing'),
          () => logger.debug('Workspace edit tracing not available')
        )

      // Set up watchers
      this.watcher = new CopilotCcreqWatcher(this.context, {
        onEditEvent: this.handleEditEvent.bind(this),
        onReadEvent: this.handleReadEvent.bind(this),
        onChatMLSuccess: this.handleChatMLSuccess.bind(this),
      })

      this.logContextWatcher = new LogContextWatcher(this.context, {
        onLogContextRecord: this.handleLogContextRecord.bind(this),
      })

      // Start watchers
      this.watcher.start()

      // Start log context watcher - this may fail silently if file doesn't exist
      const logContextStarted = await this.logContextWatcher.start()
      if (logContextStarted) {
        logger.debug(
          `LogContextWatcher started successfully, watching: ${this.logContextWatcher.getLogPath()}`
        )
      } else {
        logger.debug(
          'LogContextWatcher could not be started (file not found or permission denied)'
        )
      }

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

    try {
      if (this.watcher) {
        this.watcher.stop()
        this.watcher = null
      }

      if (this.logContextWatcher) {
        // Assuming the log context watcher has a stop method, if not this line can be removed
        // this.logContextWatcher.stop()
        this.logContextWatcher = null
      }

      // Clear state
      this.inferenceMap.clear()
      this.recordedContextIds.clear()

      this._isRunning = false
      logger.info(`${this.name} stopped`)
    } catch (err) {
      logger.error({ err }, `Error while stopping ${this.name}`)
      this._isRunning = false
    }
  }

  private async handleEditEvent(evt: ToolCall): Promise<void> {
    logger.debug(`${evt.id} - ${evt.tool}: handling edit event for filePath`)
    const inference = evt.getInference()
    if (inference && inference.length > 0) {
      logger.info(`Extracted inference for ${evt.id} - ${evt.tool}`)
      this.inferenceMap.set(makeStableId(evt.id), inference)
    } else {
      logger.info(
        `No inference extracted for ${evt.id} - ${evt.tool}, resorting to snapshot content if available`
      )
      let baselineContent: string | undefined
      if (evt.tool == 'create_file') {
        baselineContent = ''
      } else {
        baselineContent = await this.snapshot.getSnapshot(
          evt.filePath,
          Date.now()
        )
      }
      if (baselineContent !== undefined) {
        const diffInference = evt.getInferenceFromReplacements(baselineContent)
        if (diffInference && diffInference.trim().length > 0) {
          this.inferenceMap.set(makeStableId(evt.id), diffInference)
          logger.info(
            `created inference for ${evt.id} - ${evt.tool} using snapshot content and diff`
          )
        } else {
          logger.warn(`Unable to create inference for ${evt.id} - ${evt.tool}`)
        }
      } else {
        logger.warn(`No baseline content for ${evt.filePath}`)
      }
    }
  }

  private async handleReadEvent(evt: ToolCall): Promise<void> {
    try {
      await this.snapshot.onReadFile(evt)
    } catch (err) {
      logger.error({ err }, `Failed to handle read event (${evt.tool})`)
    }
  }

  private async handleChatMLSuccess(evt: ChatMLSuccess): Promise<void> {
    const model = evt.model ?? 'unknown-model'

    // Handle attachments: add to snapshot tracker
    const attachments = evt.getAttachments()
    if (attachments.length > 0) {
      for (const att of attachments) {
        // timestamp is ISO string or undefined; convert to ms or use Date.now()
        const timeMs = att.timestamp ? Date.parse(att.timestamp) : Date.now()
        await this.snapshot.addAttachmentSnapshot(att.id, att.filePath, timeMs)
        logger.debug(
          `ChatMLSuccess: added attachment snapshot for ${att.filePath} (${att.id})`
        )
      }
    }

    // Existing context/diff logic
    const toolIds = evt.getToolCallIds([...EDIT_TOOLS])
    if (!toolIds || toolIds.length === 0) {
      logger.debug(`ChatMLSuccess: no tool call id found in requestMessages`)
      return
    }
    logger.info(`ChatMLSuccess: found tool call ids: ${toolIds.join(', ')}`)
    // Extract userRequest prompt from requestMessages content blocks
    const prompt = evt.getPromptData()
    // For each tool id, emit a context if we have a diff and haven't recorded this id yet
    let wroteAny = false
    for (const id of toolIds) {
      const stable = makeStableId(String(id))
      const inference =
        this.inferenceMap.get(id) || this.inferenceMap.get(stable)
      if (inference) {
        // dedupe by stable id
        if (!this.recordedContextIds.has(stable)) {
          // Upload via Bugsy
          try {
            await uploadCopilotChanges(
              prompt,
              inference,
              model,
              new Date().toISOString()
            )
          } catch (err) {
            logger.error({ err }, `Failed uplaoding to bugsy for ${id}`)
          }
          // Update recordedContextIds so we don't duplicate next time
          this.recordedContextIds.add(stable)
          wroteAny = true
        } else {
          logger.debug(
            `ChatMLSuccess: context for tool call id ${id} already recorded`
          )
        }
      } else {
        logger.debug(`ChatMLSuccess: no inference found for tool call id ${id}`)
      }
    }
    if (!wroteAny) {
      logger.debug(
        `ChatMLSuccess: no new inferences to record for this request`
      )
    }
  }

  private async handleLogContextRecord(
    record: LogContextRecord
  ): Promise<void> {
    logger.debug(
      `LogContext: received record ${record.event.requestId} for ${record.event.filePath}`
    )

    // Extract added lines from the log context record
    const addedLines = record.computeAddedLines()
    if (addedLines.length > 0) {
      logger.info(`LogContext: extracted ${addedLines} added lines`)
      // Upload to Bugsy if accepted
      if (record.event.isAccepted) {
        await uploadCopilotChanges(
          [],
          addedLines.join('\n'),
          'copilot-inline-edit',
          new Date().toISOString(),
          AiBlameInferenceType.TabAutocomplete
        )
      }
    }
  }
}
