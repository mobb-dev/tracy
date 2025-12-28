import * as vscode from 'vscode'
import { StatusBarItem } from 'vscode'

import { EXTENSION_NAME } from '../env'

export enum LineState {
  LOADING = 'loading',
  AI = 'ai',
  HUMAN = 'human',
  NO_DATA = 'no-data', // Merges: DIRTY, NOT_COMMITTED, UNKNOWN
  ERROR = 'error',
}

export type IView = {
  /**
   * Refresh the view.
   */
  refresh(state: LineState): void

  /**
   * Display an error message in the view.
   */
  error(message: string): void
}

const STATUS_PREFIX = EXTENSION_NAME.endsWith('-dev')
  ? 'Tracey (DEV): '
  : 'Tracey: '

export class StatusBarView implements IView {
  constructor(private statusBarItem: StatusBarItem) {
    this.statusBarItem.text = STATUS_PREFIX
    this.statusBarItem.command = `${EXTENSION_NAME}.showInfoPanel`
    this.statusBarItem.show()
  }
  refresh(state: LineState): void {
    let markdown: string = ''
    switch (state) {
      case LineState.LOADING:
        this.statusBarItem.text = `${STATUS_PREFIX}$(loading~spin)`
        break
      case LineState.AI:
        this.statusBarItem.text = `${STATUS_PREFIX}$(robot)`
        markdown = 'Detected AI-generated code on this line'
        break
      case LineState.HUMAN:
        this.statusBarItem.text = `${STATUS_PREFIX}$(person)`
        markdown = 'Detected human-written code on this line'
        break
      case LineState.NO_DATA:
        this.statusBarItem.text = `${STATUS_PREFIX}$(dash)`
        markdown =
          'No AI attribution data for this line. Code must be committed and pushed for attribution.'
        break
      case LineState.ERROR:
        this.statusBarItem.text = `${STATUS_PREFIX}$(error)`
        break
      default:
        this.statusBarItem.text = `${STATUS_PREFIX}$(dash)`
    }

    this.statusBarItem.command = `${EXTENSION_NAME}.showInfoPanel`
    const fullMarkdown = this.generateMarkdown(markdown)
    const markdownString = new vscode.MarkdownString(fullMarkdown)
    markdownString.isTrusted = true // Enable command links
    markdownString.supportHtml = true // Enable HTML for better formatting
    this.statusBarItem.tooltip = markdownString
    this.statusBarItem.show()
  }

  error(message: string): void {
    this.statusBarItem.text = `${STATUS_PREFIX}$(error)`
    const fullMarkdown = this.generateMarkdown(message)
    const markdownString = new vscode.MarkdownString(fullMarkdown)
    markdownString.isTrusted = true // Enable command links
    markdownString.supportHtml = true // Enable HTML for better formatting
    this.statusBarItem.tooltip = markdownString
    this.statusBarItem.show()
  }

  private generateMarkdown(context: string | null): string {
    let markdown = ['## Mobb Tracey', '', 'AI Code Attribution']
    if (context) {
      markdown = markdown.concat(['', '---', '', context])
    }
    return markdown.join('\n')
  }
}
