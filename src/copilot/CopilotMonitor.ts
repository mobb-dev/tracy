import * as vscode from 'vscode'

import { AiBlameInferenceType } from '../mobbdev_src/features/analysis/scm/generates/client_generates'
import { initFileLogger } from '../shared/fileLogger'
import { BaseMonitor } from '../shared/IMonitor'
import { logger } from '../shared/logger'
import { AppType } from '../shared/repositoryInfo'
import { uploadCopilotChanges } from '../shared/uploader'
import { CopilotCcreqWatcher } from './copilotCcreqWatcher'
import {
  ChatMLMessage,
  ChatMLSuccess,
  ChatMLToolCall,
  EDIT_TOOLS,
  ToolCall,
} from './events'
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

  /**
   * Check if GitHub Copilot is available and functional.
   * Tests multiple indicators to ensure Copilot monitoring will work.
   *
   * @returns true if Copilot is available and ccreq scheme works
   */
  private async isCopilotAvailable(): Promise<boolean> {
    // 1. Check if GitHub Copilot extension is installed
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

    logger.info('GitHub Copilot extension detected', {
      copilot: copilotExtension?.id,
      copilotChat: copilotChatExtension?.id,
      copilotActive: copilotExtension?.isActive,
      copilotChatActive: copilotChatExtension?.isActive,
    })

    // 2. Check if ccreq: URI scheme is accessible
    try {
      const testUri = vscode.Uri.parse('ccreq:latest.copilotmd')
      await vscode.workspace.openTextDocument(testUri)
      logger.info('ccreq: URI scheme is available - CopilotMonitor will start')
      return true
    } catch (err) {
      logger.info(
        'ccreq: URI scheme not available - likely no active Copilot Chat session. ' +
          'CopilotMonitor will not start until Copilot Chat is used.',
        { error: err instanceof Error ? err.message : String(err) }
      )
      return false
    }
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

      // Check if Copilot is actually available
      const copilotAvailable = await this.isCopilotAvailable()
      if (!copilotAvailable) {
        logger.info(
          `${this.name} not started - GitHub Copilot not available. ` +
            `This is normal if Copilot is not installed or not actively being used.`
        )
        // Don't set _isRunning = true, monitor stays inactive
        return
      }

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

    // Log metadata tool names if present
    if (evt.toolNames.length > 0) {
      logger.info(
        `ChatMLSuccess: metadata.tools names: [${evt.toolNames.join(', ')}]`
      )
    }

    // Existing context/diff logic - find tool calls that match EDIT_TOOLS
    const toolIds = evt.getToolCallIds([...EDIT_TOOLS])
    if (!toolIds || toolIds.length === 0) {
      logger.info(
        `ChatMLSuccess: no matching EDIT_TOOLS found (expected: ${EDIT_TOOLS.join(', ')})`
      )
      // PRODUCTION BUG FIX (Jan 8, 2026):
      // Fallback extraction handles VS Code Copilot which doesn't emit separate toolCall events.
      // Instead, tool calls are embedded directly in ChatMLSuccess requestMessages.
      // Without this fallback, VS Code Copilot inferences are silently lost.
      await this.extractInferenceFromChatMLToolCalls(evt, model)
      return
    }
    logger.info(
      `ChatMLSuccess: found matching tool call ids: ${toolIds.join(', ')}`
    )
    // Extract userRequest prompt from requestMessages content blocks
    const prompt = evt.getPromptData()
    // For each tool id, emit a context if we have a diff and haven't recorded this id yet
    let wroteAny = false
    for (const id of toolIds) {
      const stable = makeStableId(String(id))
      let inference = this.inferenceMap.get(id) || this.inferenceMap.get(stable)

      // If no inference in map, try extracting directly from tool call arguments
      if (!inference) {
        inference = this.extractInferenceFromToolCallId(evt, id)
        if (inference) {
          logger.info(
            `ChatMLSuccess: extracted inference directly from tool call ${id}`
          )
        }
      }

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
            logger.error({ err }, `Failed uploading to bugsy for ${id}`)
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
        logger.info(`ChatMLSuccess: no inference found for tool call id ${id}`)
      }
    }
    if (!wroteAny) {
      logger.info(`ChatMLSuccess: no new inferences to record for this request`)
    }
  }

  /**
   * Extract inference directly from tool call arguments in ChatMLSuccess.
   *
   * **Production Bug Fix (Jan 8, 2026):**
   * This fallback is required for VS Code Copilot which doesn't emit separate
   * `kind: 'toolCall'` events like Cursor does. Without this, inferences from
   * multi_replace_string_in_file and other tools would be silently lost.
   *
   * @param evt ChatMLSuccess event containing embedded tool calls
   * @param toolCallId Specific tool call ID to extract inference from
   * @returns Extracted inference or undefined if not found
   */
  private extractInferenceFromToolCallId(
    evt: ChatMLSuccess,
    toolCallId: string
  ): string | undefined {
    const allToolCalls = evt.getAllToolCalls()
    for (const tc of allToolCalls) {
      if (tc.id === toolCallId) {
        // Parse the tool call from the raw event to get arguments
        const toolCall = this.findToolCallInRaw(evt, toolCallId)
        if (toolCall) {
          const toolCallObj = ToolCall.fromJson({
            id: toolCallId,
            tool: tc.name,
            kind: 'toolCall',
            args: toolCall.function?.arguments || '{}',
          })
          return toolCallObj.getInference()
        }
      }
    }
    return undefined
  }

  /**
   * Find a specific tool call by ID in the raw ChatML data
   */
  private findToolCallInRaw(
    evt: ChatMLSuccess,
    toolCallId: string
  ): ChatMLToolCall | undefined {
    const raw = evt.raw as Record<string, unknown> | undefined
    if (!raw) {
      return undefined
    }

    const requestMessages = raw.requestMessages as
      | { messages?: ChatMLMessage[] }
      | undefined
    if (!requestMessages?.messages) {
      return undefined
    }

    for (const msg of requestMessages.messages) {
      const { toolCalls } = msg
      if (!Array.isArray(toolCalls)) {
        continue
      }
      for (const tc of toolCalls) {
        if (tc.id === toolCallId) {
          return tc as ChatMLToolCall
        }
      }
    }
    return undefined
  }

  /**
   * Fallback: Extract inference directly from all tool calls in ChatMLSuccess.
   *
   * **Production Bug Fix (Jan 8, 2026):**
   * VS Code Copilot embeds tool calls in ChatMLSuccess instead of emitting separate
   * toolCall events. Without this fallback, ALL VS Code Copilot inferences would be lost.
   * This was discovered during E2E testing but affects production since Nov 2025.
   *
   * @param evt ChatMLSuccess event containing embedded tool calls
   * @param model Model name for upload metadata
   */
  private async extractInferenceFromChatMLToolCalls(
    evt: ChatMLSuccess,
    model: string
  ): Promise<void> {
    const allToolCalls = evt.getAllToolCalls()
    if (allToolCalls.length === 0) {
      logger.info(
        'ChatMLSuccess fallback: no tool calls to extract inference from'
      )
      return
    }

    logger.info(
      `ChatMLSuccess fallback: attempting to extract inference from ${allToolCalls.length} tool calls`
    )

    const prompt = evt.getPromptData()
    let wroteAny = false

    for (const tc of allToolCalls) {
      // Check if this tool is an edit tool we should process
      if (!EDIT_TOOLS.includes(tc.name as (typeof EDIT_TOOLS)[number])) {
        logger.info(`ChatMLSuccess fallback: skipping non-edit tool ${tc.name}`)
        continue
      }

      const stable = makeStableId(tc.id)
      if (this.recordedContextIds.has(stable)) {
        logger.debug(
          `ChatMLSuccess fallback: tool call ${tc.id} already recorded`
        )
        continue
      }

      // Extract inference from tool call arguments
      const toolCall = this.findToolCallInRaw(evt, tc.id)
      if (!toolCall) {
        logger.info(
          `ChatMLSuccess fallback: could not find tool call ${tc.id} in raw data`
        )
        continue
      }

      const toolCallObj = ToolCall.fromJson({
        id: tc.id,
        tool: tc.name,
        kind: 'toolCall',
        args: toolCall.function?.arguments || '{}',
      })

      const inference = toolCallObj.getInference()
      if (!inference || inference.trim().length === 0) {
        logger.info(
          `ChatMLSuccess fallback: no inference extracted from ${tc.name}`
        )
        continue
      }

      logger.info(
        `ChatMLSuccess fallback: extracted inference from ${tc.name} (${inference.length} chars)`
      )

      try {
        await uploadCopilotChanges(
          prompt,
          inference,
          model,
          new Date().toISOString()
        )
        this.recordedContextIds.add(stable)
        wroteAny = true
        logger.info(`ChatMLSuccess fallback: uploaded inference for ${tc.id}`)
      } catch (err) {
        logger.error(
          { err },
          `ChatMLSuccess fallback: failed to upload ${tc.id}`
        )
      }
    }

    if (wroteAny) {
      logger.info('ChatMLSuccess fallback: successfully uploaded inferences')
    } else {
      logger.info('ChatMLSuccess fallback: no new inferences to upload')
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
