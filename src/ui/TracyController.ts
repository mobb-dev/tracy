import * as vscode from 'vscode'

import { EXTENSION_NAME } from '../env'
import { logger } from '../shared/logger'
import { AIBlameAttribution, AIBlameCache } from './AIBlameCache'
import { GitBlameCache } from './GitBlameCache'
import { InfoPanel } from './TracyInfoPanel'
import { IView, LineState } from './TracyStatusBar'
// Special SHA used by git to indicate uncommitted/unsaved changes
const UNCOMMITTED_SHA = '0000000000000000000000000000000000000000'

// Result types for pure data loading functions
type BlameInfoResult =
  | {
      success: true
      gitBlameInfo: {
        commit: string
        originalLine: number
      }
    }
  | {
      success: false
      error: 'dirty_file' | 'no_blame_info' | 'unknown_error'
    }

type AttributionResult =
  | {
      success: true
      attribution: AIBlameAttribution
      lineState: LineState
    }
  | {
      success: false
      attribution: null
      lineState: LineState
    }

// Separate state management for status bar and info panel
type UIState = {
  version: number
  filePath: string | null
  lineNumber: number
  attribution: AIBlameAttribution | null
}

/**
 * TracyController manages the integration between git blame data, AI attribution,
 * and UI components (status bar and info panel).
 *
 * Function naming conventions:
 * - load*() = Pure data loading functions (no side effects)
 * - uiUpdate*() = Pure UI update functions (no data loading)
 * - stateUpdate*() = Pure internal state update functions
 * - handle*() = Orchestration functions (coordinate data loading + UI updates)
 */
export class TracyController {
  private disposables: vscode.Disposable[] = []
  private infoPanel?: InfoPanel

  // Separate states for independent UI components
  private statusBarState: UIState = {
    version: 0,
    filePath: null,
    lineNumber: 0,
    attribution: null,
  }

  private panelState: UIState = {
    version: 0,
    filePath: null,
    lineNumber: 0,
    attribution: null,
  }

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

  // Pure data loading functions (no UI side effects)
  private async loadBlameInfo(
    document: vscode.TextDocument,
    lineNumber: number,
    ignoreDirty: boolean
  ): Promise<BlameInfoResult> {
    // Cannot accurately provide blame for dirty files
    if (document.isDirty && !ignoreDirty) {
      return {
        success: false,
        error: 'dirty_file',
      }
    }

    try {
      // Get the git blame for the current line
      const gitBlameInfo = await this.gitCache.getBlameLine(
        document,
        lineNumber
      )

      // If no git blame info, mark as no data available
      if (
        !gitBlameInfo ||
        !gitBlameInfo.commit ||
        gitBlameInfo.commit === UNCOMMITTED_SHA
      ) {
        return {
          success: false,
          error: 'no_blame_info',
        }
      }

      return {
        success: true,
        gitBlameInfo: {
          commit: gitBlameInfo.commit,
          originalLine: gitBlameInfo.originalLine,
        },
      }
    } catch (error) {
      logger.error({ error }, 'Error loading blame info:')
      return {
        success: false,
        error: 'unknown_error',
      }
    }
  }

  private async loadAttributionData(
    blameInfo: { commit: string; originalLine: number },
    filePath: string
  ): Promise<AttributionResult> {
    try {
      const aiBlameResult = await this.aiBlameCache.getAIBlameInfoLine(
        blameInfo.commit,
        filePath,
        blameInfo.originalLine
      )

      if (aiBlameResult) {
        let lineState: LineState
        if (aiBlameResult.type === 'CHAT') {
          lineState = LineState.AI
        } else if (aiBlameResult.type === 'HUMAN_EDIT') {
          lineState = LineState.HUMAN
        } else if (aiBlameResult.type === 'TAB_AUTOCOMPLETE') {
          lineState = LineState.TAB_AUTOCOMPLETE
        } else {
          lineState = LineState.NO_ATTRIBUTION_DATA
        }

        return {
          success: true,
          attribution: aiBlameResult,
          lineState,
        }
      }
      return {
        success: false,
        attribution: null,
        // Null means no attribution exists for this line (normal case for human-written code)
        lineState: LineState.NO_ATTRIBUTION_DATA,
      }
    } catch (error) {
      logger.error({ error }, 'Error loading attribution data:')
      return {
        success: false,
        attribution: null,
        lineState: LineState.ATTRIBUTION_ERROR,
      }
    }
  }

  // Pure UI update functions (no data loading)
  private uiUpdateStatusBarState(state: LineState): void {
    this.view.refresh(state)
  }

  private async uiUpdateInfoPanelBlameState(
    state: 'LOADING' | 'SUCCESS' | 'ERROR',
    error?: string
  ): Promise<void> {
    if (this.infoPanel) {
      await this.infoPanel.updateBlameInfoState(state, error)
    }
  }

  // Pure internal state update functions for separate UI components
  private updateStatusBarState(
    updates: Partial<UIState>,
    bumpVersion: boolean = true
  ): number {
    const newVersion = bumpVersion
      ? this.statusBarState.version + 1
      : this.statusBarState.version
    this.statusBarState = {
      ...this.statusBarState,
      ...updates,
      version: newVersion,
    }
    return newVersion
  }

  private updatePanelState(
    updates: Partial<UIState>,
    bumpVersion: boolean = true
  ): number {
    const newVersion = bumpVersion
      ? this.panelState.version + 1
      : this.panelState.version
    this.panelState = {
      ...this.panelState,
      ...updates,
      version: newVersion,
    }
    return newVersion
  }

  private isStatusBarStale(version: number): boolean {
    return version !== this.statusBarState.version
  }

  private isPanelStale(version: number): boolean {
    return version !== this.panelState.version
  }

  // Orchestration functions (coordinate data + UI)
  private async handleLineChange(
    document: vscode.TextDocument,
    lineNumber: number
  ): Promise<void> {
    const filePath = document.uri.fsPath

    // Update status bar state and get version for staleness checking
    const version = this.updateStatusBarState({
      filePath,
      lineNumber,
      attribution: null,
    })

    // Update status bar to loading state
    this.uiUpdateStatusBarState(LineState.LOADING)

    try {
      // Load blame info
      const blameResult = await this.loadBlameInfo(document, lineNumber, false)
      if (this.isStatusBarStale(version)) {
        return
      }

      if (!blameResult.success) {
        if (blameResult.error === 'dirty_file') {
          this.uiUpdateStatusBarState(LineState.BLAME_DIRTY)
        } else if (blameResult.error === 'no_blame_info') {
          this.uiUpdateStatusBarState(LineState.BLAME_NOT_COMMITTED)
        } else {
          this.uiUpdateStatusBarState(LineState.BLAME_ERROR)
        }
        return
      }

      // Load attribution data
      const attributionResult = await this.loadAttributionData(
        blameResult.gitBlameInfo,
        filePath
      )
      if (this.isStatusBarStale(version)) {
        return
      }

      // Update status bar state with results
      this.updateStatusBarState(
        {
          attribution: attributionResult.attribution,
        },
        false
      )

      // Update status bar
      this.uiUpdateStatusBarState(attributionResult.lineState)
    } catch (error) {
      if (this.isStatusBarStale(version)) {
        return
      }

      logger.error({ error }, 'Error in handleLineChange:')
      this.updateStatusBarState(
        {
          attribution: null,
        },
        false
      )
      this.uiUpdateStatusBarState(LineState.ATTRIBUTION_ERROR)
    }
  }

  private async handlePanelShow(): Promise<void> {
    // Always create the panel first so we can show user-visible errors too.
    if (!this.infoPanel) {
      this.infoPanel = new InfoPanel(
        this.aiBlameCache,
        () => ({
          fileName:
            this.panelState.filePath?.split(/[/\\]/).filter(Boolean).pop() ||
            'Unknown',
          lineNumber: this.panelState.lineNumber,
          attribution: this.panelState.attribution,
          repoUrl: this.repoUrl,
        }),
        () => {
          this.infoPanel = undefined
        }
      )
    }

    // Pin a stable reference for this invocation; the user can close the panel
    // during any awaited work, which triggers onDisposed and clears this.infoPanel.
    const panel = this.infoPanel
    if (!panel) {
      return
    }

    // Check if we have a valid file being tracked by the status bar.
    // If not, we still show the panel so the user gets feedback.
    if (!this.statusBarState.filePath) {
      const version = this.updatePanelState({
        filePath: null,
        lineNumber: 0,
        attribution: null,
      })
      this.uiUpdateStatusBarState(LineState.NO_FILE_SELECTED_ERROR)
      // Set the panel's state BEFORE showing so the initial render is correct.
      await this.uiUpdateInfoPanelBlameState(
        'ERROR',
        'No file has been tracked yet'
      )
      if (this.isPanelStale(version) || this.infoPanel !== panel) {
        return
      }
      await panel.show()
      return
    }

    const { filePath } = this.statusBarState
    const { lineNumber } = this.statusBarState

    // Sync panel state to current status bar state FIRST (before show)
    const version = this.updatePanelState({
      filePath,
      lineNumber,
      attribution: null,
    })

    // Set InfoPanel blame loading state BEFORE showing so the first refresh
    // doesn't fall through to "human-written code" while we are loading.
    await this.uiUpdateInfoPanelBlameState('LOADING')
    if (this.isPanelStale(version) || this.infoPanel !== panel) {
      return
    }

    // Show panel immediately (now with correct context)
    await panel.show()
    if (this.isPanelStale(version) || this.infoPanel !== panel) {
      return
    }

    try {
      // Get TextDocument for the file we're tracking
      const fileUri = vscode.Uri.file(filePath)
      const doc = await vscode.workspace.openTextDocument(fileUri)
      if (this.isPanelStale(version) || this.infoPanel !== panel) {
        return
      }

      // Load blame info
      const blameResult = await this.loadBlameInfo(doc, lineNumber, true)
      if (this.isPanelStale(version) || this.infoPanel !== panel) {
        return
      }

      if (!blameResult.success) {
        // Determine appropriate error message based on error type
        let errorMessage: string
        switch (blameResult.error) {
          // dirty_file is not possible here since we passed ignoreDirty=true to loadBlameInfo
          //case 'dirty_file':
          //  errorMessage = 'Cannot show blame info for unsaved files'
          //  break
          case 'no_blame_info':
            errorMessage =
              'No git blame information available for this line. You may need to commit the changes first.'
            break
          case 'unknown_error':
            errorMessage = 'Failed to load git blame information'
            break
          default:
            errorMessage = 'Failed to load git blame information'
        }
        await this.uiUpdateInfoPanelBlameState('ERROR', errorMessage)
        return
      }

      // Load attribution data
      const attributionResult = await this.loadAttributionData(
        blameResult.gitBlameInfo,
        filePath
      )
      if (this.isPanelStale(version) || this.infoPanel !== panel) {
        return
      }

      // Update panel state with results
      this.updatePanelState(
        {
          attribution: attributionResult.attribution,
        },
        false
      )

      // Update InfoPanel state
      await this.uiUpdateInfoPanelBlameState('SUCCESS')
    } catch (error) {
      if (this.isPanelStale(version) || this.infoPanel !== panel) {
        return
      }

      logger.error({ error }, 'Error in handlePanelShow:')
      await this.uiUpdateInfoPanelBlameState(
        'ERROR',
        'Failed to load tracy information'
      )
    }
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
      doc.uri.fsPath === this.statusBarState.filePath &&
      lineNumber === this.statusBarState.lineNumber
    ) {
      return
    }
    logger.info(
      `Active editor changed: ${doc.uri.fsPath} at line ${lineNumber}`
    )
    await this.handleLineChange(doc, lineNumber)
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
      doc.uri.fsPath === this.statusBarState.filePath &&
      lineNumber === this.statusBarState.lineNumber
    ) {
      return
    }
    await this.handleLineChange(doc, lineNumber)
  }

  public async showInfoPanel(): Promise<void> {
    await this.handlePanelShow()
  }

  public dispose(): void {
    this.disposables.forEach((d) => d.dispose())
    if (this.infoPanel) {
      this.infoPanel.dispose()
    }
  }
}
