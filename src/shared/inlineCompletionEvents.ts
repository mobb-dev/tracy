import * as vscode from 'vscode'

/**
 * Event emitter for inline completion lifecycle events.
 * Used to coordinate between the inline completion tracker (Copilot Tab handler)
 * and the human tracking session (to flush human segments before AI text is inserted).
 */
const _onWillAcceptInlineCompletion = new vscode.EventEmitter<string>()

/** Fires with the document URI just before an inline completion is accepted. */
export const onWillAcceptInlineCompletion = _onWillAcceptInlineCompletion.event

export function fireWillAcceptInlineCompletion(documentUri: string): void {
  _onWillAcceptInlineCompletion.fire(documentUri)
}
