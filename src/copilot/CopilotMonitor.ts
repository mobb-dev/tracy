import * as vscode from 'vscode'

import { PromptItemArray } from '../mobbdev_src/args/commands/upload_ai_blame'
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
import { getMcpServerName, getMcpToolName, isMcpTool } from './utils/mcpUtils'
import {
  getSessionIdLookup,
  initSessionIdLookup,
} from './utils/sessionIdLookup'

/**
 * Buffered inference data for a generation cycle (requestId).
 */
type PendingCycleBatch = {
  requestId: string
  sessionId: string | undefined
  model: string
  prompts: PromptItemArray
  inferences: string[]
  toolCallIds: string[]
  lastUpdated: number
  /** Accumulated token counts across all ChatMLSuccess events in the cycle */
  totalInputTokens: number
  totalOutputTokens: number
  /** Track ChatMLSuccess event IDs to avoid counting tokens multiple times */
  countedEventIds: Set<string>
}

export class CopilotMonitor extends BaseMonitor {
  readonly name = 'CopilotMonitor'

  /** Timeout for flushing a batch after last activity (10 seconds)
   * Allows time for slow MCP tools to complete */
  private static readonly BATCH_FLUSH_TIMEOUT_MS = 10000

  /** TTL for recorded context IDs (5 minutes) - prevents unbounded growth */
  private static readonly RECORDED_IDS_TTL_MS = 5 * 60 * 1000

  private inferenceMap = new Map<string, string>()
  /** Map of toolCallId -> timestamp for TTL-based cleanup */
  private recordedContextIds = new Map<string, number>()
  private snapshot: SnapshotTracker
  private watcher: CopilotCcreqWatcher | null = null
  private logContextWatcher: LogContextWatcher | null = null

  /** Buffer for pending inference batches by requestId */
  private pendingBatches = new Map<string, PendingCycleBatch>()
  /** Timer for flushing batches */
  private batchFlushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private context: vscode.ExtensionContext,
    appType: AppType
  ) {
    super(appType)
    this.snapshot = new SnapshotTracker()
    // Initialize SessionIdLookup singleton with context for VS Code path resolution
    initSessionIdLookup(context)
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

    logger.debug('GitHub Copilot extension detected', {
      copilot: copilotExtension?.id,
      copilotChat: copilotChatExtension?.id,
      copilotActive: copilotExtension?.isActive,
      copilotChatActive: copilotChatExtension?.isActive,
    })

    // 2. Check if ccreq: URI scheme is accessible
    try {
      const testUri = vscode.Uri.parse('ccreq:latest.copilotmd')
      await vscode.workspace.openTextDocument(testUri)
      logger.debug('ccreq: URI scheme is available - CopilotMonitor will start')
      return true
    } catch (err) {
      logger.debug(
        'ccreq: URI scheme not available - likely no active Copilot Chat session. ' +
          'CopilotMonitor will not start until Copilot Chat is used.',
        { error: err instanceof Error ? err.message : String(err) }
      )
      return false
    }
  }

  async start(): Promise<void> {
    if (this._isRunning) {
      logger.debug(`${this.name} is already running`)
      return
    }

    logger.debug(`Starting ${this.name}`)

    try {
      // Initialize logging
      initFileLogger(this.context)

      // Check if Copilot is actually available
      const copilotAvailable = await this.isCopilotAvailable()
      if (!copilotAvailable) {
        logger.debug(
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
      // ccreq watcher is the primary data source for all Copilot events
      this.watcher = new CopilotCcreqWatcher(this.context, {
        onEditEvent: this.handleEditEvent.bind(this),
        onReadEvent: this.handleReadEvent.bind(this),
        onChatMLSuccess: this.handleChatMLSuccess.bind(this),
      })

      this.logContextWatcher = new LogContextWatcher(this.context, {
        onLogContextRecord: this.handleLogContextRecord.bind(this),
      })

      // Start ccreq watcher
      this.watcher.start()
      logger.debug('CopilotCcreqWatcher started')

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
      logger.debug(`${this.name} started successfully`)
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

    logger.debug(`Stopping ${this.name}`)

    try {
      // Flush any pending batches before stopping
      await this.flushAllPendingBatches()

      // Clear batch timer
      if (this.batchFlushTimer) {
        clearTimeout(this.batchFlushTimer)
        this.batchFlushTimer = null
      }

      if (this.watcher) {
        this.watcher.stop()
        this.watcher = null
      }

      if (this.logContextWatcher) {
        this.logContextWatcher.stop()
        this.logContextWatcher = null
      }

      // Clear state
      this.inferenceMap.clear()
      this.recordedContextIds.clear()
      this.pendingBatches.clear()

      this._isRunning = false
      logger.debug(`${this.name} stopped`)
    } catch (err) {
      logger.error({ err }, `Error while stopping ${this.name}`)
      this._isRunning = false
    }
  }

  /**
   * Flush all pending batches that have exceeded the timeout.
   */
  private async flushExpiredBatches(): Promise<void> {
    const now = Date.now()
    const expiredRequestIds: string[] = []

    for (const [requestId, batch] of this.pendingBatches) {
      if (now - batch.lastUpdated >= CopilotMonitor.BATCH_FLUSH_TIMEOUT_MS) {
        logger.debug(
          { requestId, idleMs: now - batch.lastUpdated },
          'Flushing batch due to timeout (cycle appears complete)'
        )
        expiredRequestIds.push(requestId)
      }
    }

    for (const requestId of expiredRequestIds) {
      await this.flushBatch(requestId)
    }

    // Reschedule timer if there are still pending batches
    this.scheduleBatchFlushTimer()
  }

  /**
   * Flush all pending batches immediately.
   */
  private async flushAllPendingBatches(): Promise<void> {
    const requestIds = [...this.pendingBatches.keys()]
    for (const requestId of requestIds) {
      await this.flushBatch(requestId)
    }
  }

  /**
   * Flush a specific batch by requestId.
   * The batch is removed from the map immediately to prevent race conditions
   * with new events arriving during the async upload.
   */
  private async flushBatch(requestId: string): Promise<void> {
    const batch = this.pendingBatches.get(requestId)
    // Remove immediately to prevent race conditions - new events will create a fresh batch
    this.pendingBatches.delete(requestId)

    if (!batch || batch.inferences.length === 0) {
      return
    }

    // Concatenate all inferences with double newline
    const combinedInference = batch.inferences.join('\n\n')

    // Enhance prompts with MCP detection
    this.enhancePromptsWithMcpInfo(batch.prompts)

    // Update the first prompt item with accumulated token counts
    // (tokens are typically on the first USER_PROMPT item)
    const accumulatedTokens = {
      inputCount: batch.totalInputTokens,
      outputCount: batch.totalOutputTokens,
    }

    // Find the first item with tokens and update it, or add to first item
    const itemWithTokens = batch.prompts.find((p) => p.tokens)
    if (itemWithTokens) {
      itemWithTokens.tokens = accumulatedTokens
    } else if (batch.prompts.length > 0) {
      batch.prompts[0].tokens = accumulatedTokens
    }

    // Log upload details
    const mcpTools = batch.prompts.filter((p) => p.type === 'MCP_TOOL_CALL')
    const thinkingItems = batch.prompts.filter((p) => p.type === 'AI_THINKING')
    const thinkingPreview = thinkingItems.map((t) => ({
      length: t.text?.length ?? 0,
      preview: t.text?.slice(0, 200) ?? '',
    }))

    logger.info(
      {
        requestId,
        model: batch.model,
        sessionId: batch.sessionId ?? 'not-found',
        inferenceCount: batch.inferences.length,
        combinedInferenceLength: combinedInference.length,
        promptCount: batch.prompts.length,
        mcpToolCount: mcpTools.length,
        mcpServers: [
          ...new Set(mcpTools.map((t) => t.tool?.mcpServer).filter(Boolean)),
        ],
        tokens: accumulatedTokens,
        thinkingCount: thinkingItems.length,
        thinkingPreview: thinkingPreview.length > 0 ? thinkingPreview : 'none',
        toolCallIds: batch.toolCallIds,
      },
      'Flushing batched inference for generation cycle'
    )

    try {
      await uploadCopilotChanges(
        batch.prompts,
        combinedInference,
        batch.model,
        new Date().toISOString(),
        AiBlameInferenceType.Chat,
        batch.sessionId
      )
      logger.info(
        { requestId, sessionId: batch.sessionId ?? 'not-found' },
        'Batched inference upload completed successfully'
      )
    } catch (err) {
      logger.error({ err, requestId }, 'Failed to upload batched inference')
    }

    // Mark all tool call IDs as recorded (with timestamp for TTL cleanup)
    const now = Date.now()
    for (const id of batch.toolCallIds) {
      this.recordedContextIds.set(makeStableId(id), now)
    }
    this.cleanupRecordedContextIds()
  }

  /**
   * Remove expired entries from recordedContextIds to prevent unbounded growth.
   */
  private cleanupRecordedContextIds(): void {
    const cutoff = Date.now() - CopilotMonitor.RECORDED_IDS_TTL_MS
    let cleaned = 0
    for (const [id, timestamp] of this.recordedContextIds) {
      if (timestamp < cutoff) {
        this.recordedContextIds.delete(id)
        cleaned++
      }
    }
    if (cleaned > 0) {
      logger.debug(
        { cleaned, remaining: this.recordedContextIds.size },
        'Cleaned up expired recordedContextIds'
      )
    }
  }

  /**
   * Schedule or reschedule the batch flush timer.
   */
  private scheduleBatchFlushTimer(): void {
    if (this.batchFlushTimer) {
      clearTimeout(this.batchFlushTimer)
    }

    if (this.pendingBatches.size > 0) {
      this.batchFlushTimer = setTimeout(() => {
        this.flushExpiredBatches().catch((err) => {
          logger.error({ err }, 'Error flushing expired batches')
        })
      }, CopilotMonitor.BATCH_FLUSH_TIMEOUT_MS)
    }
  }

  /**
   * Add an inference to the batch for a generation cycle.
   * When a new requestId is seen, flush all other pending batches first.
   */
  private addToBatch(
    requestId: string,
    eventId: string,
    inference: string,
    toolCallId: string,
    sessionId: string | undefined,
    model: string,
    prompts: PromptItemArray,
    inputTokens: number,
    outputTokens: number
  ): void {
    // Flush any OTHER pending batches when we see a new requestId
    // This indicates a new generation cycle has started
    for (const [pendingRequestId] of this.pendingBatches) {
      if (pendingRequestId !== requestId) {
        logger.debug(
          { oldRequestId: pendingRequestId, newRequestId: requestId },
          'New generation cycle detected, flushing previous batch'
        )
        // Fire and forget - don't await to avoid blocking
        this.flushBatch(pendingRequestId).catch((err) => {
          logger.error(
            { err, requestId: pendingRequestId },
            'Error flushing batch on new cycle'
          )
        })
      }
    }

    let batch = this.pendingBatches.get(requestId)

    if (!batch) {
      batch = {
        requestId,
        sessionId,
        model,
        prompts: [...prompts], // Copy prompts
        inferences: [],
        toolCallIds: [],
        lastUpdated: Date.now(),
        totalInputTokens: 0,
        totalOutputTokens: 0,
        countedEventIds: new Set(),
      }
      this.pendingBatches.set(requestId, batch)
    }

    // Only count tokens once per ChatMLSuccess event (not per tool call)
    if (!batch.countedEventIds.has(eventId)) {
      batch.totalInputTokens += inputTokens
      batch.totalOutputTokens += outputTokens
      batch.countedEventIds.add(eventId)
      logger.debug(
        { eventId, inputTokens, outputTokens },
        'Added tokens from ChatMLSuccess event'
      )
    }

    // Add inference if not already added (by tool call ID)
    if (!batch.toolCallIds.includes(toolCallId)) {
      batch.inferences.push(inference)
      batch.toolCallIds.push(toolCallId)
      batch.lastUpdated = Date.now()

      // Update prompts with latest (they accumulate tool calls)
      batch.prompts = [...prompts]

      // Update sessionId if we found one
      if (sessionId && !batch.sessionId) {
        batch.sessionId = sessionId
      }

      logger.debug(
        {
          requestId,
          toolCallId,
          inferenceCount: batch.inferences.length,
          totalInputTokens: batch.totalInputTokens,
          totalOutputTokens: batch.totalOutputTokens,
        },
        'Added inference to batch'
      )
    }

    // Schedule flush timer
    this.scheduleBatchFlushTimer()
  }

  private async handleEditEvent(evt: ToolCall): Promise<void> {
    logger.debug(`${evt.id} - ${evt.tool}: handling edit event for filePath`)

    // Tool call completed - reset timer if we have pending batches
    // This keeps batches waiting while tools are still executing
    if (this.pendingBatches.size > 0) {
      logger.debug(
        { tool: evt.tool, pendingBatches: this.pendingBatches.size },
        'Tool call completed, resetting batch flush timer'
      )
      this.scheduleBatchFlushTimer()
    }
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
    // Tool call completed - reset timer if we have pending batches
    // This keeps batches waiting while tools are still executing
    if (this.pendingBatches.size > 0) {
      logger.debug(
        { tool: evt.tool, pendingBatches: this.pendingBatches.size },
        'Tool call completed, resetting batch flush timer'
      )
      this.scheduleBatchFlushTimer()
    }

    try {
      await this.snapshot.onReadFile(evt)
    } catch (err) {
      logger.error({ err }, `Failed to handle read event (${evt.tool})`)
    }
  }

  /**
   * Log a summary of prompt data for debugging purposes.
   * Extracts counts by type, token presence, attached files, and tool names.
   */
  private logPromptSummary(prompt: PromptItemArray, context: string): void {
    const promptSummary = {
      totalItems: prompt.length,
      byType: prompt.reduce(
        (acc, p) => {
          acc[p.type] = (acc[p.type] || 0) + 1
          return acc
        },
        {} as Record<string, number>
      ),
      hasTokens: prompt.some((p) => p.tokens),
      hasAttachedFiles: prompt.some(
        (p) => p.attachedFiles && p.attachedFiles.length > 0
      ),
      toolNames: prompt.filter((p) => p.tool?.name).map((p) => p.tool?.name),
    }
    logger.debug(
      { promptSummary },
      `${context}: enhanced prompt data extracted`
    )
  }

  private async handleChatMLSuccess(evt: ChatMLSuccess): Promise<void> {
    const model = evt.model ?? 'unknown-model'
    const { requestId } = evt

    // Log cycle completion signals for analysis
    // Track event sequence to verify endTime is only present when cycle is truly complete
    const existingBatch = this.pendingBatches.get(requestId ?? '')
    const eventSequenceNum = existingBatch
      ? existingBatch.inferences.length + 1
      : 1
    const toolCallCount = evt.getAllToolCallIds().length
    const editToolCount = evt.getToolCallIds([...EDIT_TOOLS]).length

    logger.debug(
      {
        requestId,
        eventSequenceNum, // Which event # for this requestId
        hasEndTime: evt.endTime !== undefined,
        endTime: evt.endTime?.toISOString(),
        hasDuration: evt.durationMs !== undefined,
        durationMs: evt.durationMs,
        startTime: evt.startTime?.toISOString(),
        toolCallCount, // Total tool calls in this event
        editToolCount, // Edit tools specifically
        model,
        // If endTime is present but we already have events, it might be streaming
        potentialPrematureEndTime:
          evt.endTime !== undefined && eventSequenceNum > 1,
      },
      'ChatMLSuccess: cycle completion signals - VERIFY endTime timing'
    )

    // Extract token counts from this event's usage
    const inputTokens = evt.usage?.prompt_tokens ?? 0
    const outputTokens = evt.usage?.completion_tokens ?? 0

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
      logger.debug(
        `ChatMLSuccess: metadata.tools names: [${evt.toolNames.join(', ')}]`
      )
    }

    // Log requestId for debugging
    if (requestId) {
      logger.debug({ requestId }, 'ChatMLSuccess: processing request')
    }

    // Get all tool call IDs for sessionId lookup
    const allToolCallIds = evt.getAllToolCallIds()

    // Look up sessionId from session files using tool call IDs
    let sessionId: string | undefined
    if (allToolCallIds.length > 0) {
      try {
        sessionId =
          (await getSessionIdLookup().findSessionId(allToolCallIds)) ??
          undefined
        if (sessionId) {
          logger.debug({ sessionId }, 'ChatMLSuccess: found sessionId')
        }
      } catch (err) {
        logger.warn({ err }, 'ChatMLSuccess: failed to lookup sessionId')
      }
    }

    // Existing context/diff logic - find tool calls that match EDIT_TOOLS
    const toolIds = evt.getToolCallIds([...EDIT_TOOLS])
    if (!toolIds || toolIds.length === 0) {
      logger.debug(
        `ChatMLSuccess: no matching EDIT_TOOLS found (expected: ${EDIT_TOOLS.join(', ')})`
      )
      // PRODUCTION BUG FIX (Jan 8, 2026):
      // Fallback extraction handles VS Code Copilot which doesn't emit separate toolCall events.
      // Instead, tool calls are embedded directly in ChatMLSuccess requestMessages.
      // Without this fallback, VS Code Copilot inferences are silently lost.
      await this.extractInferenceFromChatMLToolCalls(
        evt,
        model,
        sessionId,
        requestId
      )
      return
    }
    logger.debug(
      `ChatMLSuccess: found matching tool call ids: ${toolIds.join(', ')}`
    )
    // Extract userRequest prompt from requestMessages content blocks
    const prompt = evt.getPromptData()

    this.logPromptSummary(prompt, 'ChatMLSuccess')

    // Collect inferences for this event
    let addedAny = false
    for (const id of toolIds) {
      const stable = makeStableId(String(id))

      // Skip if already recorded
      if (this.recordedContextIds.has(stable)) {
        logger.debug(
          `ChatMLSuccess: context for tool call id ${id} already recorded`
        )
        continue
      }

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
        if (requestId) {
          // Batch by requestId for generation cycle grouping
          this.addToBatch(
            requestId,
            evt.id,
            inference,
            id,
            sessionId,
            model,
            prompt,
            inputTokens,
            outputTokens
          )
          addedAny = true
        } else {
          // No requestId - upload immediately (legacy behavior)
          logger.warn(
            { toolCallId: id },
            'ChatMLSuccess: no requestId, uploading immediately'
          )
          this.enhancePromptsWithMcpInfo(prompt)
          try {
            await uploadCopilotChanges(
              prompt,
              inference,
              model,
              new Date().toISOString(),
              AiBlameInferenceType.Chat,
              sessionId
            )
            this.recordedContextIds.set(stable, Date.now())
            addedAny = true
          } catch (err) {
            logger.error({ err }, `Failed uploading to bugsy for ${id}`)
          }
        }
      } else {
        logger.info(`ChatMLSuccess: no inference found for tool call id ${id}`)
      }
    }

    if (!addedAny) {
      logger.debug(
        `ChatMLSuccess: no new inferences to record for this request`
      )
    }
  }

  /**
   * Enhance prompt items with MCP detection based on tool name prefix.
   * MCP tools have names starting with "mcp_" (e.g., "mcp_datadog_list_metrics").
   */
  private enhancePromptsWithMcpInfo(prompts: PromptItemArray): void {
    for (let i = 0; i < prompts.length; i++) {
      const item = prompts[i]
      if (item.tool?.name && isMcpTool(item.tool.name)) {
        // Replace item with MCP_TOOL_CALL type variant
        prompts[i] = {
          ...item,
          type: 'MCP_TOOL_CALL',
          tool: {
            ...item.tool,
            mcpServer: getMcpServerName(item.tool.name),
            mcpToolName: getMcpToolName(item.tool.name),
          },
        }
      }
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
   * @param sessionId Optional sessionId from session file lookup
   * @param requestId Optional requestId for generation cycle batching
   */
  private async extractInferenceFromChatMLToolCalls(
    evt: ChatMLSuccess,
    model: string,
    sessionId?: string,
    requestId?: string
  ): Promise<void> {
    const allToolCalls = evt.getAllToolCalls()
    if (allToolCalls.length === 0) {
      logger.debug(
        'ChatMLSuccess fallback: no tool calls to extract inference from'
      )
      return
    }

    logger.debug(
      `ChatMLSuccess fallback: attempting to extract inference from ${allToolCalls.length} tool calls`
    )

    // Extract token counts from this event's usage
    const inputTokens = evt.usage?.prompt_tokens ?? 0
    const outputTokens = evt.usage?.completion_tokens ?? 0

    const prompt = evt.getPromptData()

    this.logPromptSummary(prompt, 'ChatMLSuccess fallback')

    let addedAny = false

    for (const tc of allToolCalls) {
      // Check if this tool is an edit tool we should process
      if (!EDIT_TOOLS.includes(tc.name as (typeof EDIT_TOOLS)[number])) {
        logger.debug(
          `ChatMLSuccess fallback: skipping non-edit tool ${tc.name}`
        )
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
        logger.debug(
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
        {
          toolCallId: tc.id,
          toolName: tc.name,
          inferenceLength: inference.length,
        },
        'ChatMLSuccess fallback: extracted inference'
      )

      if (requestId) {
        // Batch by requestId for generation cycle grouping
        this.addToBatch(
          requestId,
          evt.id,
          inference,
          tc.id,
          sessionId,
          model,
          prompt,
          inputTokens,
          outputTokens
        )
        addedAny = true
      } else {
        // No requestId - upload immediately (legacy behavior)
        logger.warn(
          { toolCallId: tc.id },
          'ChatMLSuccess fallback: no requestId, uploading immediately'
        )
        this.enhancePromptsWithMcpInfo(prompt)
        try {
          await uploadCopilotChanges(
            prompt,
            inference,
            model,
            new Date().toISOString(),
            AiBlameInferenceType.Chat,
            sessionId
          )
          this.recordedContextIds.set(stable, Date.now())
          addedAny = true
        } catch (err) {
          logger.error(
            { err },
            `ChatMLSuccess fallback: failed to upload ${tc.id}`
          )
        }
      }
    }

    if (addedAny) {
      logger.debug('ChatMLSuccess fallback: inferences added to batch')
    } else {
      logger.debug('ChatMLSuccess fallback: no new inferences to process')
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
      logger.debug(`LogContext: extracted ${addedLines} added lines`)
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
