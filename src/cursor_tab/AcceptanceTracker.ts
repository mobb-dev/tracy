import { clearInterval, setInterval } from 'node:timers'

import * as vscode from 'vscode'

import { logger } from '../shared/logger'

export type AcceptedCompletionCallback = (additions: string) => void

type PendingCompletion = {
  additions: string
  documentUri: string
  timestamp: number
}

const ACCEPTANCE_TIMEOUT_MS = 60_000

export class AcceptanceTracker implements vscode.Disposable {
  private pendingCompletions: Map<string, PendingCompletion[]> = new Map()
  private disposables: vscode.Disposable[] = []
  private cleanupInterval: ReturnType<typeof setInterval> | undefined

  constructor(private onAccepted: AcceptedCompletionCallback) {
    const subscription = vscode.workspace.onDidChangeTextDocument((event) =>
      this.handleDocumentChange(event)
    )
    this.disposables.push(subscription)

    this.cleanupInterval = setInterval(
      () => this.cleanupStaleCompletions(),
      ACCEPTANCE_TIMEOUT_MS
    )
  }

  trackPendingCompletion(additions: string, documentUri: string): void {
    const pending: PendingCompletion = {
      additions: this.normalizeText(additions),
      documentUri,
      timestamp: Date.now(),
    }

    const existing = this.pendingCompletions.get(documentUri) ?? []
    existing.push(pending)
    this.pendingCompletions.set(documentUri, existing)

    logger.debug(
      `Tracking pending completion for ${documentUri}: ${additions.slice(0, 50)}...`
    )
  }

  private handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    const documentUri = event.document.uri.toString()
    const pendingList = this.pendingCompletions.get(documentUri)

    if (!pendingList || pendingList.length === 0) {
      return
    }

    for (const change of event.contentChanges) {
      const insertedText = this.normalizeText(change.text)

      if (insertedText.length === 0) {
        continue
      }

      logger.debug(`Inserted text: ${insertedText}`)

      // Match if pending completion ends with inserted text
      // (user typed prefix "hel", completion is "hello world", inserted text is "lo world")
      const matchIndex = pendingList.findIndex((pending) =>
        pending.additions.endsWith(insertedText)
      )

      if (matchIndex !== -1) {
        const matched = pendingList[matchIndex]
        pendingList.splice(matchIndex, 1)

        if (pendingList.length === 0) {
          this.pendingCompletions.delete(documentUri)
        }

        logger.debug(
          `Completion accepted for ${documentUri}: ${matched.additions.slice(0, 50)}...`
        )
        this.onAccepted(matched.additions)
        return
      }
    }
  }

  private cleanupStaleCompletions(): void {
    const now = Date.now()

    for (const [uri, pendingList] of this.pendingCompletions.entries()) {
      const filtered = pendingList.filter((pending) => {
        const isStale = now - pending.timestamp > ACCEPTANCE_TIMEOUT_MS
        if (isStale) {
          logger.debug(
            `Discarding stale completion for ${uri}: ${pending.additions.slice(0, 50)}...`
          )
        }
        return !isStale
      })

      if (filtered.length === 0) {
        this.pendingCompletions.delete(uri)
      } else {
        this.pendingCompletions.set(uri, filtered)
      }
    }
  }

  private normalizeText(text: string): string {
    return text.replace(/\r\n/g, '\n').trim()
  }

  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
    }
    for (const disposable of this.disposables) {
      disposable.dispose()
    }
    this.pendingCompletions.clear()
  }
}
