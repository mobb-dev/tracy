import type * as vscode from 'vscode'

import { HUMAN_TRACKING_CONFIG } from './config'
import { EventClassification, type EventClassificationCode } from './types'

export type EventShape = Pick<vscode.TextDocumentChangeEvent, 'contentChanges'>

// Pattern to detect whitespace-only text
const WHITESPACE_ONLY_PATTERN = /^\s+$/

/**
 * Classifies a text document change event based on its shape (number of
 * contentChanges and size of the first insertion).
 */
export function detectEventClassification(event: EventShape): {
  eventClassification: EventClassificationCode
  changeCount: number
  firstInsertSize: number
} {
  if (!event.contentChanges || event.contentChanges.length === 0) {
    return {
      eventClassification: EventClassification.EMPTY,
      changeCount: 0,
      firstInsertSize: 0,
    }
  }

  // Check for multi-line human edit changes (same content on multiple consecutive lines, like indentation or multi-line comments)
  if (isMultiLineHumanEdit(event)) {
    return {
      eventClassification: EventClassification.MULTI_LINE_HUMAN_EDIT,
      changeCount: event.contentChanges.length,
      firstInsertSize: event.contentChanges[0]?.text?.length ?? 0,
    }
  }

  const changeCount = event.contentChanges.length
  const firstChangeText = event.contentChanges[0]?.text ?? ''
  const firstInsertSize = firstChangeText.length

  // Multiple simultaneous changes → non-human group (format event).
  if (changeCount > 1) {
    return {
      eventClassification: EventClassification.MULTI_CHANGE,
      changeCount,
      firstInsertSize,
    }
  }

  // Large single insertion → paste/autocomplete/generation.
  // We also get this when a file is saved outside of VS Code (entire content replaced or a large chunk edited).
  // If the file is very small then this could also be falsely marked as human even if it came from outside.
  if (
    firstInsertSize >
    HUMAN_TRACKING_CONFIG.classifier.largeSingleInsertThreshold
  ) {
    // Check if the insert is whitespace-only (e.g., Enter key with auto-indentation).
    // Whitespace-only inserts are still considered human-like even if they exceed the threshold.
    if (WHITESPACE_ONLY_PATTERN.test(firstChangeText)) {
      return {
        eventClassification: EventClassification.WHITE_SPACE_INSERT,
        changeCount,
        firstInsertSize,
      }
    }
    return {
      eventClassification: EventClassification.LARGE_INSERT,
      changeCount,
      firstInsertSize,
    }
  }

  // Default: single small change (candidate human edit).
  return {
    eventClassification: EventClassification.SINGLE_CHANGE,
    changeCount,
    firstInsertSize,
  }
}

//check if exactly the same content is added/removed on multiple lines consecutive lines
function isMultiLineHumanEdit(event: EventShape): boolean {
  if (!event.contentChanges || event.contentChanges.length === 0) {
    return false
  }

  if (event.contentChanges.length < 2) {
    return false
  }

  //sort changes by starting line
  const sortedChanges = event.contentChanges.slice().sort((a, b) => {
    return a.range.start.line - b.range.start.line
  })
  const firstChange = sortedChanges[0]
  if (!firstChange) {
    return false
  }
  const firstChangeStartLine = firstChange.range.start.line
  const firstChangeEndLine = firstChange.range.end.line
  if (firstChangeEndLine !== firstChangeStartLine) {
    return false
  }
  const firstChangeEndStartDiff =
    firstChange.range.end.character - firstChange.range.start.character
  const firstChangeContent = firstChange.text || ''
  if (firstChangeContent.includes('\n')) {
    return false
  }
  let lastLineIndex = firstChangeStartLine
  for (let i = 1; i < sortedChanges.length; i++) {
    const change = sortedChanges[i]
    const changeStartLine = change.range.start.line
    const changeEndLine = change.range.end.line
    const content = change.text || ''
    const endStartDiff =
      change.range.end.character - change.range.start.character
    // Check if this change is on the next consecutive line
    if (changeStartLine !== lastLineIndex + 1) {
      return false
    }
    // Check if this change is on a single line (not spanning multiple lines)
    if (changeStartLine !== changeEndLine) {
      return false
    }
    lastLineIndex = changeStartLine
    if (content !== firstChangeContent) {
      return false
    }
    if (endStartDiff !== firstChangeEndStartDiff) {
      return false
    }
  }
  return true
}
