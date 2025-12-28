import * as vscode from 'vscode'

import { EXTENSION_NAME } from '../env'
import { logger } from '../shared/logger'
import { AIBlameAttribution, AIBlameCache } from './AIBlameCache'
import { GitBlameCache } from './GitBlameCache'
import { InfoPanel } from './TraceyInfoPanel'
import { IView, LineState } from './TraceyStatusBar'
// Special SHA used by git to indicate uncommitted/unsaved changes
const UNCOMMITTED_SHA = '0000000000000000000000000000000000000000'

export class TraceyController {
  private disposables: vscode.Disposable[] = []
  private currentFilePath: string | null = null
  private currentLineNumber: number = 0
  private currentAttribution: AIBlameAttribution | null = null
  private infoPanel?: InfoPanel
  /**
   * Monotonically increasing request id for blame updates.
   * Used to prevent slower, stale async requests from overwriting the UI.
   */
  private blameUpdateRequestId = 0

  constructor(
    private gitCache: GitBlameCache,
    private aiBlameCache: AIBlameCache,
    private view: IView,
    private repoUrl: string = ''
  ) {
    this.setupEventListeners()

    // Register VS Code command
    const disposable = vscode.commands.registerCommand(
      `${EXTENSION_NAME}.showInfoPanel`,
      () => void this.showInfoPanel()
    )
    this.disposables.push(disposable)
  }

  private setupEventListeners(): void {
    // Listen to selection changes
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(
        this.onSelectionChange.bind(this)
      )
    )

    // Listen to active editor changes
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(
        this.onActiveEditorChange.bind(this)
      )
    )

    // Initial update if there's an active editor
    if (vscode.window.activeTextEditor) {
      this.onActiveEditorChange(vscode.window.activeTextEditor)
    }
  }

  private isValidFile(document: vscode.TextDocument): boolean {
    // Only process actual files, not output channels, settings, etc.
    if (document.uri.scheme !== 'file') {
      logger.debug(`Skipping non-file URI: ${document.uri.toString()}`)
      return false
    }

    // Skip untitled documents
    if (document.isUntitled) {
      logger.debug(`Skipping untitled document: ${document.uri.toString()}`)
      return false
    }

    // Skip output channels and other VS Code internal documents
    const path = document.uri.fsPath
    if (
      !path ||
      path.includes('extension-output') ||
      path.includes('output:')
    ) {
      logger.debug(
        `Skipping internal document: ${path || document.uri.toString()}`
      )
      return false
    }

    return true
  }

  private async onActiveEditorChange(
    editor: vscode.TextEditor | undefined
  ): Promise<void> {
    if (!editor) {
      return
    }
    const doc = editor.document

    if (!doc || !this.isValidFile(doc)) {
      return
    }

    const lineNumber = editor.selection.active.line + 1 // Convert to 1-based
    // Only update if the linenumber has changed or the document has changed
    if (
      doc.uri.fsPath === this.currentFilePath &&
      lineNumber === this.currentLineNumber
    ) {
      return
    }
    logger.info(
      `Active editor changed: ${doc.uri.fsPath} at line ${lineNumber}`
    )
    await this.updateBlameInfo(doc, lineNumber)
  }

  private async onSelectionChange(
    event: vscode.TextEditorSelectionChangeEvent
  ): Promise<void> {
    if (!event.textEditor || event.selections.length === 0) {
      return
    }

    const doc = event.textEditor.document
    if (!doc || !this.isValidFile(doc)) {
      return
    }

    const selection = event.selections[0]
    const lineNumber = selection.active.line + 1 // Convert to 1-based
    logger.info(`Selection changed: ${doc.uri.fsPath} at line ${lineNumber}`)

    // Only update if the linenumber has changed or the document has changed
    if (
      doc.uri.fsPath == this.currentFilePath &&
      lineNumber == this.currentLineNumber
    ) {
      return
    }
    await this.updateBlameInfo(doc, lineNumber)
  }

  private async updateBlameInfo(
    document: vscode.TextDocument,
    lineNumber: number,
    ignoreDirty: boolean = false
  ): Promise<void> {
    const filePath = document.uri.fsPath
    const requestId = ++this.blameUpdateRequestId

    const isStale = (): boolean => requestId !== this.blameUpdateRequestId

    // Set view to loading state
    this.view.refresh(LineState.LOADING)

    try {
      this.currentFilePath = filePath
      this.currentLineNumber = lineNumber
      this.currentAttribution = null

      // Cannot accurately provide blame for dirty files
      if (document.isDirty && !ignoreDirty) {
        if (!isStale()) {
          this.view.refresh(LineState.NO_DATA)
        }
        return
      }
      // Get the git blame for the current line
      const gitBlameInfo = await this.gitCache.getBlameLine(
        document,
        lineNumber
      )

      if (isStale()) {
        logger.debug(
          `Skipping stale blame update for ${filePath}:${lineNumber} (request ${requestId})`
        )
        return
      }

      // If no git blame info, mark as no data available
      if (
        !gitBlameInfo ||
        !gitBlameInfo.commit ||
        gitBlameInfo.commit === UNCOMMITTED_SHA
      ) {
        if (!isStale()) {
          this.view.refresh(LineState.NO_DATA)
        }
        return
      }
      logger.info(
        `Found commit SHA: ${gitBlameInfo.commit}, original line: ${gitBlameInfo.originalLine}`
      )

      // Get AI blame info for the commit and original line
      const aiBlameResult = await this.aiBlameCache.getAIBlameInfoLine(
        gitBlameInfo.commit,
        filePath,
        gitBlameInfo.originalLine
      )
      if (isStale()) {
        logger.debug(
          `Skipping stale AI blame update for ${filePath}:${lineNumber} (request ${requestId})`
        )
        return
      }
      if (aiBlameResult) {
        if (isStale()) {
          return
        }
        // Store the full attribution data for webview
        this.currentAttribution = aiBlameResult
        if (aiBlameResult.type === 'CHAT') {
          if (!isStale()) {
            this.view.refresh(LineState.AI)
          }
        } else if (aiBlameResult.type === 'HUMAN_EDIT') {
          if (!isStale()) {
            this.view.refresh(LineState.HUMAN)
          }
        } else {
          if (!isStale()) {
            this.view.refresh(LineState.NO_DATA)
          }
        }
      } else {
        if (!isStale()) {
          this.view.refresh(LineState.NO_DATA)
        }
      }
    } catch (error) {
      if (isStale()) {
        logger.debug(
          `Ignoring error from stale blame update for ${filePath}:${lineNumber} (request ${requestId})`
        )
        return
      }
      logger.error('Error updating blame info:', error)
      this.currentAttribution = null
      this.view.error(String(error))
    }
  }

  public async showInfoPanel(): Promise<void> {
    // Refresh blame before showing panel
    const editor = vscode.window.activeTextEditor
    if (editor && this.isValidFile(editor.document)) {
      const doc = editor.document
      const lineNumber = editor.selection.active.line + 1
      // Ignore dirty here to let user see info panel even if file is unsaved
      await this.updateBlameInfo(doc, lineNumber, true)
    } else {
      this.view.error('No active file to show info for')
      return
    }

    if (!this.infoPanel) {
      this.infoPanel = new InfoPanel(
        this.aiBlameCache,
        () => ({
          fileName:
            this.currentFilePath?.split(/[/\\]/).filter(Boolean).pop() ||
            'Unknown',
          lineNumber: this.currentLineNumber,
          attribution: this.currentAttribution,
          repoUrl: this.repoUrl,
        }),
        () => {
          this.infoPanel = undefined
        }
      )
    }
    await this.infoPanel.show()
  }

  public dispose(): void {
    this.disposables.forEach((d) => d.dispose())
    if (this.infoPanel) {
      this.infoPanel.dispose()
    }
  }
}
