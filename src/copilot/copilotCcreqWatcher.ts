import { clearInterval, setInterval } from 'node:timers'

import * as vscode from 'vscode'

import { logJsonToFile } from '../shared/fileLogger'
import { logger } from '../shared/logger'
import { ChatMLSuccess, EDIT_TOOLS, READ_TOOLS, ToolCall } from './events'
import { normalizeToolId } from './utils/ids'

export type CopilotCcreqWatcherOptions = {
  /** URI for the copilot markdown "latest" file (default: ccreq:latest.copilotmd) */
  latestMdUri?: vscode.Uri
  /** Edit events: insert_edit_into_file, apply_patch, replace_string_in_file */
  onEditEvent?: (evt: ToolCall) => void | Promise<void>
  /** Read events: read_file */
  onReadEvent?: (evt: ToolCall) => void | Promise<void>
  /** Chat completion events */
  onChatMLSuccess?: (evt: ChatMLSuccess) => void | Promise<void>
}

/**
 * Watches `ccreq:latest.copilotmd`, extracts the current tool-call id, opens `ccreq:<id>.json`,
 * de-dupes events, and dispatches to tool-specific handlers.
 */
export class CopilotCcreqWatcher {
  private readonly latestMd: vscode.Uri
  private readonly opt: CopilotCcreqWatcherOptions
  private lastSeenId?: string
  private latestMdOpenInterval?: ReturnType<typeof setInterval>

  constructor(
    private ctx: vscode.ExtensionContext,
    opt?: CopilotCcreqWatcherOptions
  ) {
    this.opt = opt ?? {}
    this.latestMd =
      this.opt.latestMdUri ?? vscode.Uri.parse('ccreq:latest.copilotmd')
  }

  stop(): void {
    if (this.latestMdOpenInterval) {
      clearInterval(this.latestMdOpenInterval)
    }
  }

  start(): void {
    const changeEvent = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== 'ccreq') {
        return
      }

      // latest markdown changed → pull latest id → fetch event JSON
      this.pullLatestById().catch((err) => {
        logger.warn({ err }, 'pullLatestById failed')
      })
    })

    this.ctx.subscriptions.push(changeEvent)

    // Open latestMd so we get change events.
    this.openLatestMd().catch((err) => {
      logger.error({ err }, `Failed to open ${this.latestMd.toString()}`)
    })

    // It is essential to keep latestMd open as we heavily relay on the change
    // events for this file. So, keep it open by timer.
    this.latestMdOpenInterval = setInterval(() => {
      this.openLatestMd().catch((err) => {
        logger.error({ err }, `Failed to open ${this.latestMd.toString()}`)
      })
    }, 5000)
  }

  private async openLatestMd() {
    return await vscode.workspace.openTextDocument(this.latestMd)
  }

  private async pullLatestById(): Promise<void> {
    const mdDoc = await this.openLatestMd()
    const id = this.extractIdFromMarkdown(mdDoc.getText())
    if (!id) {
      logger.debug(
        `No tool-call id found in ${this.latestMd.toString()} (showing first 200 chars)\n${mdDoc.getText().slice(0, 200)}`
      )
      return
    }
    await this.pullJsonAndProcess(id)
  }

  private async pullJsonAndProcess(id: string): Promise<void> {
    try {
      const obj = await this.loadAndParseJson(id)
      if (!obj) {
        return
      }

      const trimmedId = this.extractAndNormalizeId(obj, id)
      this.logEventInfo(id, obj)

      if (this.isDuplicateEvent(trimmedId)) {
        logger.debug(`Duplicate tool call ignored: ${trimmedId}`)
        return
      }
      this.lastSeenId = trimmedId

      await logJsonToFile(obj, trimmedId ?? id, 'events')
      await this.dispatchEvent(obj)
    } catch (err) {
      logger.error({ err }, `Failed to open ccreq:${id}.json`)
    }
  }

  private async loadAndParseJson(
    id: string
  ): Promise<Record<string, unknown> | null> {
    const idJson = vscode.Uri.parse(`ccreq:${id}.json`)
    const doc = await vscode.workspace.openTextDocument(idJson)
    const raw = doc.getText()

    try {
      const objUnknown = JSON.parse(raw)
      return isRecord(objUnknown) ? objUnknown : {}
    } catch (err) {
      logger.warn({ err }, `Tool JSON not valid yet (${idJson.toString()})`)
      return null
    }
  }

  private extractAndNormalizeId(
    obj: Record<string, unknown>,
    fallbackId: string
  ): string | undefined {
    const id = typeof obj.id === 'string' ? obj.id : fallbackId
    return normalizeToolId(id)
  }

  private logEventInfo(id: string, obj: Record<string, unknown>): void {
    if (this.isToolCallEvent(obj)) {
      const tool = obj.tool as unknown as string
      logger.info(`ccreq:${id}.json parsed as tool=${tool}`)
    } else if (this.isChatMLSuccessEvent(obj)) {
      logger.info(`ccreq:${id}.json parsed as ChatMLSuccess`)
    } else {
      const kind = obj.kind as unknown as string
      const tool = obj.tool as unknown as string
      logger.warn(`ccreq:${id}.json unknown kind=${kind} tool=${tool}`)
    }
  }

  private isDuplicateEvent(trimmedId: string | undefined): boolean {
    return Boolean(trimmedId && trimmedId === this.lastSeenId)
  }

  private async dispatchEvent(obj: Record<string, unknown>): Promise<void> {
    if (this.isToolCallEvent(obj)) {
      await this.handleToolCallEvent(obj)
    } else if (this.isChatMLSuccessEvent(obj)) {
      await this.handleChatMLSuccessEvent(obj)
    }
  }

  private isToolCallEvent(obj: Record<string, unknown>): boolean {
    return isRecord(obj) && obj.kind === 'toolCall'
  }

  private isChatMLSuccessEvent(obj: Record<string, unknown>): boolean {
    return (
      isRecord(obj) && obj.kind === 'request' && obj.type === 'ChatMLSuccess'
    )
  }

  private async handleToolCallEvent(
    obj: Record<string, unknown>
  ): Promise<void> {
    const evt = ToolCall.fromJson(obj)

    if (EDIT_TOOLS.includes(evt.tool as (typeof EDIT_TOOLS)[number])) {
      await this.handleEditEvent(evt)
    } else if (READ_TOOLS.includes(evt.tool as (typeof READ_TOOLS)[number])) {
      await this.handleReadEvent(evt)
    } else {
      logger.warn(`Unhandled tool kind: ${evt.tool}`)
    }
  }

  private async handleEditEvent(evt: ToolCall): Promise<void> {
    try {
      await this.opt.onEditEvent?.(evt)
    } catch (err) {
      logger.warn({ err }, `Failed to handle edit event (${evt.tool})`)
    }
  }

  private async handleReadEvent(evt: ToolCall): Promise<void> {
    try {
      await this.opt.onReadEvent?.(evt)
    } catch (err) {
      logger.warn({ err }, `Failed to handle read event (${evt.tool})`)
    }
  }

  private async handleChatMLSuccessEvent(
    obj: Record<string, unknown>
  ): Promise<void> {
    try {
      const evt = ChatMLSuccess.fromJson(obj)
      await this.opt.onChatMLSuccess?.(evt)
    } catch (err) {
      logger.warn({ err }, 'Failed to parse ChatMLSuccess')
    }
  }

  /** Matches both headers:
   *   "# <debugName> - <id>"
   *   "# Tool Call - <id>"
   */
  private extractIdFromMarkdown(text: string): string | undefined {
    const toolMatch = text.match(/^#\s+Tool Call\s+-\s+([^\s]+)$/m)
    if (toolMatch) {
      return toolMatch[1]
    }

    const reqMatch = text.match(/^#\s+[^\n]+-\s+([0-9a-f]{8})$/im)
    if (reqMatch) {
      return reqMatch[1]
    }

    return undefined
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}
