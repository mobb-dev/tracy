import { randomBytes } from 'crypto'
import * as vscode from 'vscode'
import { z } from 'zod'

import { EXTENSION_NAME } from '../env'
import { logger } from '../shared/logger'
import { infoPanelTemplate } from '../webview/templates/panels/infoPanel'
import { AIBlameAttribution, AIBlameCache } from './AIBlameCache'

export type TracyPanelContext = {
  fileName: string
  lineNumber: number
  attribution: AIBlameAttribution | null
  repoUrl?: string
  promptContent?: string
}

type ConversationMessage = { type: string; text: string; date: string }

const ConversationMessageSchema = z.object({
  type: z.string().default(''),
  text: z.string().min(1),
  date: z.string().default(''),
})

// NOTE: We intentionally do NOT use `z.array(ConversationMessageSchema)` here.
// If any single message is invalid (e.g. empty `text`), Zod would fail the whole
// parse and we'd lose the rest of the conversation. Instead, validate each
// element independently and keep only the valid ones.
const ConversationSchema = z.array(z.unknown()).transform((messages) =>
  messages.flatMap((msg) => {
    const parsed = ConversationMessageSchema.safeParse(msg)
    return parsed.success ? [parsed.data] : []
  })
)

type ConversationLoadingState = 'IDLE' | 'LOADING' | 'SUCCESS' | 'ERROR'
type BlameInfoLoadingState = 'IDLE' | 'LOADING' | 'SUCCESS' | 'ERROR'

export class InfoPanel implements vscode.Disposable {
  public static readonly viewType = `${EXTENSION_NAME}.infoPanel`

  private panel?: vscode.WebviewPanel
  private readonly disposables: vscode.Disposable[] = []

  // panel-owned state
  private promptContent?: string
  private cachedAttributionId?: string
  private conversationState: ConversationLoadingState = 'IDLE'
  private conversationError?: string
  private blameInfoState: BlameInfoLoadingState = 'IDLE'
  private blameInfoError?: string
  private dataLoadVersion = 0

  constructor(
    private readonly aiBlameCache: AIBlameCache,
    private readonly getCtx: () => TracyPanelContext,
    private readonly onDisposed?: () => void
  ) {}

  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, false)
    } else {
      this.panel = vscode.window.createWebviewPanel(
        InfoPanel.viewType,
        'Tracy AI Information',
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
      )

      this.panel.onDidDispose(() => this.disposePanel(), null, this.disposables)

      this.panel.webview.onDidReceiveMessage(
        (msg) => this.onMessage(msg),
        null,
        this.disposables
      )
    }

    // Refresh to load data and show content
    await this.refresh()
  }

  private async autoLoadConversation(version: number): Promise<void> {
    const ctx = this.getCtx()
    const { attribution } = ctx
    if (!attribution) {
      // Check version before applying changes
      if (version !== this.dataLoadVersion) {
        return
      }

      this.conversationState = 'IDLE'
      this.promptContent = undefined
      this.cachedAttributionId = undefined
      this.conversationError = undefined
      return
    }

    // Skip if already loaded for this attribution
    if (this.promptContent && this.cachedAttributionId === attribution.id) {
      return
    }

    // Clear cached data if attribution changed
    if (
      this.cachedAttributionId &&
      this.cachedAttributionId !== attribution.id
    ) {
      this.promptContent = undefined
      this.conversationError = undefined
    }

    // Set loading state
    if (version !== this.dataLoadVersion) {
      return
    }
    this.conversationState = 'LOADING'
    this.cachedAttributionId = attribution.id

    try {
      const promptContent = await this.aiBlameCache.getAIBlamePrompt(
        attribution.id
      )

      // Check version before applying results
      if (version !== this.dataLoadVersion) {
        return
      }

      if (promptContent) {
        this.promptContent = promptContent
        this.conversationState = 'SUCCESS'
        this.conversationError = undefined
      } else {
        this.conversationState = 'ERROR'
        this.conversationError = 'No conversation data available'
      }
    } catch (error) {
      // Check version before applying error state
      if (version !== this.dataLoadVersion) {
        return
      }

      logger.error({ error }, 'Failed to auto-load conversation')
      this.conversationState = 'ERROR'
      this.conversationError = 'Loading AI conversation failed'
      this.promptContent = undefined
    }
  }

  private parseConversation(
    promptContent?: string
  ): ConversationMessage[] | undefined {
    if (!promptContent) {
      return []
    }

    try {
      const parsed = JSON.parse(promptContent)
      return ConversationSchema.parse(parsed)
    } catch (error) {
      logger.error({ error }, 'Failed to parse conversation')
      return undefined
    }
  }

  async refresh(): Promise<void> {
    if (!this.panel) {
      return
    }

    // Increment version for this data loading operation
    const currentVersion = ++this.dataLoadVersion

    // Load conversation data first
    await this.autoLoadConversation(currentVersion)

    // Check if this version is still current after async loading
    if (currentVersion !== this.dataLoadVersion) {
      return // A newer refresh operation has started, ignore this one
    }

    // Check if panel still exists after async operation
    if (!this.panel) {
      return // Panel was disposed during async operation
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
        conversationState: this.conversationState,
        conversationError: this.conversationError,
        blameInfoState: this.blameInfoState,
        blameInfoError: this.blameInfoError,
      }
    )
  }

  public async updateBlameInfoState(
    state: BlameInfoLoadingState,
    error?: string
  ): Promise<void> {
    this.blameInfoState = state
    this.blameInfoError = error
    await this.refresh()
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

      const prompt = `I want you to consider the previous conversation as context:\n\n${this.formatConversationForChat(conversation)}\n\nYou are now continuing the conversation, don't take any action based on the conversation, your next response should be based to ask the user how they would like to proceed.`
      // Execute the VS Code command to start a new chat with context
      // This opens a fresh chat session instead of appending to current chat
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: prompt,
      })
    } catch (error) {
      logger.error({ error }, 'Failed to continue conversation')
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
