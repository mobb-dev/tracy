import { randomBytes } from 'crypto'
import * as vscode from 'vscode'

import { EXTENSION_NAME } from '../env'
import { logger } from '../shared/logger'
import { infoPanelTemplate } from '../webview/templates/panels/infoPanel'
import { AIBlameAttribution, AIBlameCache } from './AIBlameCache'

export type TraceyPanelContext = {
  fileName: string
  lineNumber: number
  attribution: AIBlameAttribution | null
  repoUrl?: string
  promptContent?: string
}

type ConversationMessage = { type: string; text: string; date: string }

export class InfoPanel implements vscode.Disposable {
  public static readonly viewType = `${EXTENSION_NAME}.infoPanel`

  private panel?: vscode.WebviewPanel
  private readonly disposables: vscode.Disposable[] = []

  // panel-owned state
  private promptContent?: string

  constructor(
    private readonly aiBlameCache: AIBlameCache,
    private readonly getCtx: () => TraceyPanelContext,
    private readonly onDisposed?: () => void
  ) {}

  async show(): Promise<void> {
    if (this.panel) {
      await this.refresh()
      this.panel.reveal(vscode.ViewColumn.Beside, false)
      return
    }

    this.panel = vscode.window.createWebviewPanel(
      InfoPanel.viewType,
      'Tracey AI Information',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    )

    this.panel.onDidDispose(() => this.disposePanel(), null, this.disposables)

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.onMessage(msg),
      null,
      this.disposables
    )

    // Auto-load conversation when panel opens (not on cursor line changes)
    await this.autoLoadConversation()
    await this.refresh()
  }

  private async autoLoadConversation(): Promise<void> {
    const ctx = this.getCtx()
    const { attribution } = ctx
    if (!attribution) {
      return
    }

    // Skip if already loaded
    if (this.promptContent) {
      return
    }

    try {
      const promptContent = await this.aiBlameCache.getAIBlamePrompt(
        attribution.id
      )
      if (promptContent) {
        this.promptContent = promptContent
      }
    } catch (error) {
      logger.error('Failed to auto-load conversation:', error)
    }
  }

  private parseConversation(
    promptContent?: string
  ): ConversationMessage[] | undefined {
    if (!promptContent) {
      return []
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(promptContent)
    } catch (error) {
      logger.error('Failed to parse prompt content:', error)
      return undefined
    }

    if (!Array.isArray(parsed)) {
      logger.warn(
        'Prompt content JSON was valid but not an array; ignoring conversation'
      )
      return []
    }

    const conversation: ConversationMessage[] = []
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) {
        continue
      }
      const m = item as Record<string, unknown>
      const text = typeof m.text === 'string' ? m.text : ''
      if (!text) {
        continue
      }
      conversation.push({
        type: typeof m.type === 'string' ? m.type : '',
        text,
        date: typeof m.date === 'string' ? m.date : '',
      })
    }

    return conversation
  }

  async refresh(): Promise<void> {
    if (!this.panel) {
      return
    }

    const ctx = this.getCtx()

    // Parse conversation from promptContent
    const conversation = this.parseConversation(this.promptContent) ?? []

    this.panel.webview.html = infoPanelTemplate(
      { nonce: randomBytes(16).toString('hex') },
      {
        fileName: ctx.fileName,
        lineNumber: ctx.lineNumber,
        attribution: ctx.attribution,
        repoUrl: ctx.repoUrl,
        conversation,
      }
    )
  }

  dispose(): void {
    this.disposePanel()
    vscode.Disposable.from(...this.disposables).dispose()
  }

  private disposePanel(): void {
    if (!this.panel) {
      return
    }
    const p = this.panel
    this.panel = undefined
    try {
      p.dispose()
    } catch {
      logger.error('Error disposing info panel')
    }
    this.onDisposed?.()
  }

  private async onMessage(
    message:
      | { command: 'continueConversation' }
      | { command: 'openCommitOnGitHub'; url: string }
      | { command: string; [key: string]: unknown }
  ): Promise<void> {
    const ctx = this.getCtx()
    const { attribution } = ctx
    switch (message?.command) {
      case 'openCommitOnGitHub': {
        const { url } = message as { command: string; url: string }
        if (url) {
          await vscode.env.openExternal(vscode.Uri.parse(url))
        }
        return
      }

      case 'continueConversation': {
        if (!attribution) {
          return
        }

        if (!this.promptContent) {
          return
        }
        await this.continueConversation()
        return
      }

      default:
        return
    }
  }

  private async continueConversation(): Promise<void> {
    try {
      if (!this.promptContent) {
        logger.error('No prompt content found for conversation continuation')
        return
      }

      // Parse the conversation data
      const conversation = this.parseConversation(this.promptContent)
      if (!conversation) {
        // Parsing failed (invalid JSON); keep existing behavior and bail.
        return
      }

      const prompt = `I want you to consider the previous conversation as context:\n\n${this.formatConversationForChat(conversation)}\n\nYou are now continuing the conversation, dont take any action based on the conversation, your next response should be based to ask the user how they would like to proceed.`
      // Execute the VS Code command to start a new chat with context
      // This opens a fresh chat session instead of appending to current chat
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: prompt,
      })
    } catch (error) {
      logger.error('Failed to continue conversation:', error)
      vscode.window.showErrorMessage('Failed to open chat conversation')
    }
  }

  private formatConversationForChat(
    conversation: Array<{ type: string; text: string; date: string }>
  ): string {
    return conversation
      .map((message) => {
        const speaker = message.type === 'USER_PROMPT' ? 'User' : 'Assistant'
        return `${speaker}: ${message.text}`
      })
      .join('\n\n')
  }
}
