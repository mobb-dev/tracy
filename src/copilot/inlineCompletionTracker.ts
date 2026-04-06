import * as vscode from 'vscode'

import {
  EditType,
  InferencePlatform,
} from '../mobbdev_src/features/analysis/scm/generates/client_generates'
import { getConfig } from '../shared/config'
import { fireWillAcceptInlineCompletion } from '../shared/inlineCompletionEvents'
import { logger } from '../shared/logger'
import { getNormalizedRepoUrl } from '../shared/repositoryInfo'
import { uploadTracyRecords } from '../shared/uploader'

/**
 * Tracks Copilot inline completion acceptances by intercepting the Tab key
 * when an inline suggestion is visible (via VS Code context key).
 *
 * Flow:
 * 1. User sees Copilot ghost text → `inlineSuggestionVisible` context key is true
 * 2. User presses Tab → our keybinding fires (before VS Code's default)
 * 3. We snapshot the document at cursor position
 * 4. We execute the real `editor.action.inlineSuggest.commit`
 * 5. We diff the document to extract the inserted text
 * 6. We upload the diff as TabAutocomplete
 */
export function registerInlineCompletionTracker(
  context: vscode.ExtensionContext
): void {
  const disposable = vscode.commands.registerCommand(
    'mobb.acceptInlineCompletion',
    async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) {
        // No editor — fall through to default Tab
        await vscode.commands.executeCommand(
          'editor.action.inlineSuggest.commit'
        )
        return
      }

      // Flush any pending human segment BEFORE the AI text is inserted.
      // This ensures the human-typed prefix (e.g., "function add(") is captured
      // separately from the Copilot completion.
      fireWillAcceptInlineCompletion(editor.document.uri.toString())

      // Snapshot before acceptance
      const doc = editor.document
      const cursorPos = editor.selection.active
      const textBefore = doc.getText()

      // Execute the real acceptance command
      await vscode.commands.executeCommand('editor.action.inlineSuggest.commit')

      // Diff after acceptance
      const textAfter = doc.getText()

      if (textAfter === textBefore) {
        // Nothing changed — suggestion may have been dismissed
        return
      }

      // Extract the inserted text by finding the diff
      const additions = extractInsertedText(textBefore, textAfter, cursorPos)

      if (!additions || additions.trim().length < 2) {
        return
      }

      logger.info(
        `Copilot inline completion accepted: ${additions.length} chars`
      )

      // Upload asynchronously — don't block the editor
      uploadCompletion(additions, doc.uri.toString()).catch((err) => {
        logger.error({ err }, 'Failed to upload Copilot inline completion')
      })
    }
  )

  context.subscriptions.push(disposable)
  logger.debug('Registered Copilot inline completion tracker')
}

/**
 * Extract inserted text by comparing before/after document text.
 * The insertion starts at the cursor position.
 */
function extractInsertedText(
  before: string,
  after: string,
  cursorPos: vscode.Position
): string | null {
  // Find where the texts diverge
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')

  // Simple approach: the diff starts at the cursor line
  const cursorLine = cursorPos.line
  const cursorChar = cursorPos.character

  // Count new lines added
  const linesAdded = afterLines.length - beforeLines.length

  if (linesAdded === 0) {
    // Single-line completion: extract only the newly inserted characters
    const beforeLine = beforeLines[cursorLine] ?? ''
    const afterLine = afterLines[cursorLine] ?? ''
    const insertedLength = afterLine.length - beforeLine.length
    if (insertedLength > 0) {
      return afterLine.slice(cursorChar, cursorChar + insertedLength)
    }
    return null
  }

  // Multi-line completion: extract all new/changed lines
  const insertedLines: string[] = []

  // Changed line at cursor
  const beforeLine = beforeLines[cursorLine] ?? ''
  const afterLine = afterLines[cursorLine] ?? ''
  if (afterLine !== beforeLine) {
    insertedLines.push(afterLine.slice(cursorChar))
  }

  // Newly inserted lines
  for (let i = cursorLine + 1; i <= cursorLine + linesAdded; i++) {
    if (i < afterLines.length) {
      insertedLines.push(afterLines[i])
    }
  }

  return insertedLines.join('\n') || null
}

async function uploadCompletion(
  additions: string,
  fileUri: string
): Promise<void> {
  const filePath = fileUri.startsWith('file://')
    ? vscode.Uri.parse(fileUri).fsPath
    : undefined
  const repositoryUrl = await getNormalizedRepoUrl(filePath)

  await uploadTracyRecords([
    {
      platform: InferencePlatform.Copilot,
      recordId: crypto.randomUUID(),
      recordTimestamp: new Date().toISOString(),
      editType: EditType.TabAutocomplete,
      additions,
      filePath,
      repositoryUrl: repositoryUrl ?? undefined,
      clientVersion: getConfig().extensionVersion,
    },
  ])
}
