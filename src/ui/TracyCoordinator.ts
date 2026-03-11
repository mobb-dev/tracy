import * as vscode from 'vscode'

import { EXTENSION_NAME } from '../env'
import { logger } from '../shared/logger'
import { GitRepository } from '../shared/repositoryInfo'
import { AIBlameCache } from './AIBlameCache'
import { GitBlameCache } from './GitBlameCache'
import { TracyController } from './TracyController'
import { IView, LineState } from './TracyStatusBar'

/**
 * TracyCoordinator owns a single set of VS Code event listeners and routes
 * each event to whichever TracyController owns the active file.
 *
 * Benefits over per-controller listeners:
 * - VS Code fires each event exactly once regardless of how many repos are open.
 * - The showInfoPanel command is registered exactly once (avoids duplicate command errors).
 * - Cross-controller in-flight invalidation is explicit and centralised.
 */
export class TracyCoordinator {
  private disposables: vscode.Disposable[] = []
  private activeController: TracyController | null = null
  private readonly controllers: TracyController[]

  constructor(
    repositories: GitRepository[],
    organizationId: string,
    private readonly view: IView
  ) {
    this.controllers = repositories.map(
      (repo) =>
        new TracyController(
          new GitBlameCache(repo.gitRoot),
          new AIBlameCache(repo.gitRepoUrl, organizationId, repo.gitRoot),
          view,
          repo.gitRepoUrl,
          repo.gitRoot
        )
    )
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(
        this.onSelectionChange.bind(this)
      ),
      vscode.window.onDidChangeActiveTextEditor(
        this.onActiveEditorChange.bind(this)
      ),
      vscode.commands.registerCommand(
        `${EXTENSION_NAME}.showInfoPanel`,
        () => void this.showInfoPanel()
      )
    )

    // Initial update if there's already an active editor when the extension loads.
    if (vscode.window.activeTextEditor) {
      void this.onActiveEditorChange(vscode.window.activeTextEditor)
    }
  }

  public refreshActiveEditor(): void {
    void this.onActiveEditorChange(vscode.window.activeTextEditor)
  }

  private findController(filePath: string): TracyController | undefined {
    return this.controllers.find((c) => c.isFileInRepo(filePath))
  }

  private async onActiveEditorChange(
    editor: vscode.TextEditor | undefined
  ): Promise<void> {
    if (!editor) {
      // Check if there are actually any visible text editors
      // Don't clear state just because focus shifted to a web view or panel
      const visibleEditors = vscode.window.visibleTextEditors.filter(
        (e) => e.document.uri.scheme === 'file'
      )

      if (visibleEditors.length === 0) {
        // Truly no file editors open - invalidate and show appropriate state
        this.activeController?.invalidate()
        this.activeController = null
        this.view.refresh(LineState.NO_FILE_SELECTED_ERROR)
      }
      // If there are still visible editors, maintain current state
      return
    }

    if (editor.document.uri.scheme !== 'file') {
      return
    }

    const filePath = editor.document.uri.fsPath
    const controller = this.findController(filePath)

    if (!controller) {
      logger.debug(
        `TracyCoordinator: file outside all tracked repos: ${filePath}`
      )
      // Invalidate any in-flight blame so its result doesn't overwrite the
      // OUTSIDE_REPO state we're about to set.
      this.activeController?.invalidate()
      this.activeController = null
      this.view.refresh(LineState.OUTSIDE_REPO)
      return
    }
    logger.info(`TracyCoordinator: active editor changed to ${filePath}`)
    // Switching between repos — cancel in-flight work in the old controller.
    if (this.activeController && this.activeController !== controller) {
      this.activeController.invalidate()
    }

    this.activeController = controller
    await controller.handleEditorChange(editor)
  }

  private onSelectionChange(
    event: vscode.TextEditorSelectionChangeEvent
  ): void {
    if (!event.textEditor || event.selections.length === 0) {
      return
    }

    const { document } = event.textEditor
    if (document.uri.scheme !== 'file') {
      return
    }

    const controller = this.findController(document.uri.fsPath)
    if (!controller) {
      // File is outside all repos; onActiveEditorChange already showed OUTSIDE_REPO.
      return
    }

    if (this.activeController && this.activeController !== controller) {
      this.activeController.invalidate()
    }
    this.activeController = controller
    controller.handleSelectionChange(event)
  }

  private async showInfoPanel(): Promise<void> {
    if (!this.activeController) {
      logger.warn(
        'TracyCoordinator: showInfoPanel invoked with no active controller'
      )
      return
    }
    await this.activeController.showInfoPanel()
  }

  public dispose(): void {
    this.disposables.forEach((d) => d.dispose())
    this.controllers.forEach((c) => c.dispose())
  }
}
