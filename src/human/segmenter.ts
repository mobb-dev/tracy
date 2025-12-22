import * as vscode from 'vscode'

import { logger } from '../shared/logger'
import {
  EventClassification,
  EventClassificationCode,
  isEventHuman,
} from './types'

/** Counts newlines in text (VS Code normalizes all endings to \n). */
function countNewlines(text: string): number {
  return (text.match(/\n/g) || []).length
}

/** Gap in lines between two half-open intervals. Returns 0 if overlapping/touching. */
export function computeIntervalDistancePostChange(
  segmentStartPostChange: number,
  segmentEndExclusivePostChange: number,
  changeStartPostChange: number,
  changeEndExclusivePostChange: number
): number {
  // Check for overlap: intervals overlap if start of one is less than end of other
  const doIntervalsOverlap =
    segmentStartPostChange < changeEndExclusivePostChange &&
    changeStartPostChange < segmentEndExclusivePostChange
  if (doIntervalsOverlap) {
    return 0
  }

  // Change is entirely above segment
  if (changeEndExclusivePostChange <= segmentStartPostChange) {
    return segmentStartPostChange - changeEndExclusivePostChange
  }

  // Change is entirely below segment
  return changeStartPostChange - segmentEndExclusivePostChange
}

/** Net line delta: inserted newlines - deleted lines. */
export function computeNetLineDelta(
  changeStartLine: number,
  changeEndLine: number,
  insertedText: string
): {
  netLineDelta: number
  deletedLineCount: number
  insertedNewlineCount: number
} {
  const deletedLineCount = changeEndLine - changeStartLine
  const insertedNewlineCount = countNewlines(insertedText)
  return {
    netLineDelta: insertedNewlineCount - deletedLineCount,
    deletedLineCount,
    insertedNewlineCount,
  }
}
/** Extracts change coordinates and converts VS Code range to half-open interval. */
function extractChangeCoordinates(
  change: vscode.TextDocumentContentChangeEvent
) {
  const changeStartLine = change.range.start.line
  const changeEndLine = change.range.end.line
  const insertedText = change.text

  const { netLineDelta, deletedLineCount, insertedNewlineCount } =
    computeNetLineDelta(changeStartLine, changeEndLine, insertedText)

  const changeEndLineExclusive = changeEndLine + 1 // Convert to half-open interval

  return {
    netLineDelta,
    deletedLineCount,
    insertedNewlineCount,
    changeStartLine,
    changeEndLineExclusive,
    changeEndLineExclusivePostChange: changeEndLineExclusive + netLineDelta,
  }
}

//There are 2 cases for human edits:
//1. A single change edit with human written text
//2. Multiple line edits where the same content is added/removed on multiple consecutive lines (e.g. adding comment markers or indentation on multiple lines)
export function getEventStartLineAndEndLineFromHumanEvent(
  event: vscode.TextDocumentChangeEvent
) {
  if (!event.contentChanges || event.contentChanges.length === 0) {
    throw new Error(
      'Cannot extract start and end lines from event with no content changes'
    )
  }
  // For multi-line human edits, we need to find the min start line and max end line across all changes
  let minStartLine = Number.MAX_SAFE_INTEGER
  let maxEndLineExclusive = -1
  for (const change of event.contentChanges) {
    const changeStartLine = change.range.start.line
    const changeEndLineExclusive = change.range.end.line + 1 // Convert to half-open interval
    if (changeStartLine < minStartLine) {
      minStartLine = changeStartLine
    }
    if (changeEndLineExclusive > maxEndLineExclusive) {
      maxEndLineExclusive = changeEndLineExclusive
    }
  }
  // For multi-line human edits (commenting, indentation), no lines are added or removed
  // For single-line edits, calculate the actual line delta
  let netLineDelta = 0
  if (event.contentChanges.length === 1) {
    const changeText = event.contentChanges[0].text
    netLineDelta = computeNetLineDelta(
      minStartLine,
      maxEndLineExclusive - 1,
      changeText
    ).netLineDelta
  }
  const eventEndLineExclusivePostChange = maxEndLineExclusive + netLineDelta
  return {
    eventStartLine: minStartLine,
    eventEndLineExclusive: maxEndLineExclusive,
    eventEndLineExclusivePostChange,
  }
}

export function rebaseSegmentAndMergeOverlappingChangesForDocumentEvent(
  segment: Segment,
  event: vscode.TextDocumentChangeEvent
): void {
  const changesFromEndToStart = event.contentChanges.slice().sort((a, b) => {
    const lineDiff = b.range.start.line - a.range.start.line
    if (lineDiff !== 0) {
      return lineDiff
    }
    return b.range.start.character - a.range.start.character
  })
  for (const change of changesFromEndToStart) {
    const {
      netLineDelta,
      changeStartLine,
      deletedLineCount,
      insertedNewlineCount,
    } = extractChangeCoordinates(change)
    if (changeStartLine >= segment.rangeEndLineExclusive) {
      // Change is entirely below segment, no impact
      continue
    } else if (changeStartLine + deletedLineCount < segment.rangeStartLine) {
      // Change is entirely above segment, we shift the segment
      segment.rangeStartLine += netLineDelta
      segment.rangeEndLineExclusive += netLineDelta
    } else if (
      // Change is within segment
      changeStartLine >= segment.rangeStartLine &&
      changeStartLine + deletedLineCount < segment.rangeEndLineExclusive
    ) {
      // Change is within segment, we shift only the end line
      segment.rangeEndLineExclusive += netLineDelta
    } else if (
      // Change overlaps the start of the segment
      changeStartLine < segment.rangeStartLine &&
      changeStartLine + deletedLineCount >= segment.rangeStartLine &&
      changeStartLine + deletedLineCount < segment.rangeEndLineExclusive
    ) {
      segment.rangeStartLine = changeStartLine
      segment.rangeEndLineExclusive += netLineDelta
    } else if (
      // Change overlaps the end of the segment
      changeStartLine >= segment.rangeStartLine &&
      changeStartLine < segment.rangeEndLineExclusive &&
      changeStartLine + deletedLineCount >= segment.rangeEndLineExclusive
    ) {
      // We shift the end line to the change start line
      segment.rangeEndLineExclusive = changeStartLine + insertedNewlineCount
    } else {
      // Change completely covers the segment (removes the segment and adds other content instead)
      segment.rangeStartLine = changeStartLine
      segment.rangeEndLineExclusive = changeStartLine + insertedNewlineCount
    }
  }
}

export type Segment = {
  closed: boolean
  documentUri: string
  fileName: string
  // Half-open interval [rangeStartLine, rangeEndLineExclusive) defines the segment's line range
  rangeStartLine: number // Inclusive start line (0-based)
  rangeEndLineExclusive: number // Exclusive end line (0-based)
  textContent: string // Cache content in case of a non-human edit, this is the content to be uploaded
  startedAt: number // Timestamp when segment was created
  endedAt: number // Timestamp when segment was closed
}

type SegmenterConfig = {
  now: number
  maxSegmentDurationMs: number
  maxSegmentChars: number
  adjacencyGapLines: number
  eventClassification: EventClassificationCode
}

export class Segmenter {
  /**
   * Tracks one open segment per document (keyed by URI).
   * Users can edit multiple files; each needs independent tracking (separate line numbers, timers).
   */
  private currentOpenSegments: Map<string, Segment> = new Map()
  private lastDocumentChangeAt: Map<string, number> = new Map()

  getAllOpenSegmentsURIs(): string[] {
    return Array.from(this.currentOpenSegments.keys())
  }

  onDidCloseTextDocument(documentUri: string): Segment[] {
    const closedSegments: Segment[] = []
    const segment = this.currentOpenSegments.get(documentUri)
    if (segment) {
      logger.info(
        `Human Code: closing segment due to document close for document ${segment.fileName}`
      )
      closedSegments.push(this.closeSegmentByDocURI(documentUri)!)
    }
    return closedSegments
  }

  onDidChangeTextDocument(
    event: vscode.TextDocumentChangeEvent,
    cfg: SegmenterConfig
  ): Segment[] {
    // Collect all segments closed during this event (can be multiple)
    const closedSegments: Segment[] = []
    const currentDocument = event.document
    const docUriAsKey = currentDocument.uri.toString()

    const currentSegment = this.currentOpenSegments.get(docUriAsKey)
    // If it is an empty event or a format event, we just rebase the current segment (if any) and return
    if (
      EventClassification.MULTI_CHANGE === cfg.eventClassification ||
      EventClassification.EMPTY === cfg.eventClassification
    ) {
      if (currentSegment) {
        rebaseSegmentAndMergeOverlappingChangesForDocumentEvent(
          currentSegment,
          event
        )
      }
      this.lastDocumentChangeAt.set(docUriAsKey, cfg.now)
      return closedSegments
    }

    if (isEventHuman(cfg.eventClassification)) {
      const humanClosedSegments = this.processHumanChanges(
        currentDocument,
        event,
        cfg
      )
      this.lastDocumentChangeAt.set(docUriAsKey, cfg.now)
      closedSegments.push(...humanClosedSegments)
      return closedSegments
    }

    // Non-human event: close current segment (if any)
    if (currentSegment) {
      const closedSegment = this.closeSegmentByDocURI(docUriAsKey)
      if (closedSegment) {
        closedSegments.push(closedSegment)
      }
    }

    return closedSegments
  }

  /**
   * Process HUMAN changes: rebase/merge the current segment window and update metrics.
   * Returns any segments closed during processing.
   */
  private processHumanChanges(
    currentDocument: vscode.TextDocument,
    event: vscode.TextDocumentChangeEvent,
    cfg: SegmenterConfig
  ): Segment[] {
    const { eventStartLine, eventEndLineExclusivePostChange } =
      getEventStartLineAndEndLineFromHumanEvent(event)
    const docUriAsKey = currentDocument.uri.toString()
    // If we do not have a segment for this document, we set one and return
    if (!this.currentOpenSegments.get(docUriAsKey)) {
      this.createOpenSegment(
        currentDocument,
        eventStartLine,
        eventEndLineExclusivePostChange,
        cfg.now
      )
      // No closed segments
      return []
    }

    const closedSegments: Segment[] = []

    // Check if we need to close the current segment before processing this change.
    // It could be stale (no recent edits) or too large (text content wise).
    const currentOpenSegment = this.currentOpenSegments.get(docUriAsKey)!
    if (this.shouldSegmentForDocumentBeClosed(currentOpenSegment, cfg)) {
      // After closing this segment, we continue to process the current change (which starts a new segment)
      closedSegments.push(
        this.closeSegmentAndOpenNewOne({
          segmentToClose: currentOpenSegment,
          document: currentDocument,
          rangeStartLine: eventStartLine,
          rangeEndLineExclusive: eventEndLineExclusivePostChange,
          startedAt: cfg.now,
        })
      )
      return closedSegments
    }

    // Rebase and merge overlapping changes into current segment
    // After this point the segment coordinates are in post-change space
    const currentSegment = this.currentOpenSegments.get(docUriAsKey)!
    rebaseSegmentAndMergeOverlappingChangesForDocumentEvent(
      currentSegment,
      event
    )

    // Calculate gap between change and segment (post-change coordinates)
    const gap = computeIntervalDistancePostChange(
      currentSegment.rangeStartLine,
      currentSegment.rangeEndLineExclusive,
      eventStartLine,
      eventEndLineExclusivePostChange
    )

    if (gap > cfg.adjacencyGapLines) {
      // This segment must be closed now since the gap between this segment
      // and the next change is greater than the adjacency gap
      closedSegments.push(
        this.closeSegmentAndOpenNewOne({
          segmentToClose: currentSegment,
          document: currentDocument,
          rangeStartLine: eventStartLine,
          rangeEndLineExclusive: eventEndLineExclusivePostChange,
          startedAt: cfg.now,
        })
      )
    } else {
      // Changes are next to the segment, we will expand the segment
      currentSegment.rangeStartLine = Math.min(
        currentSegment.rangeStartLine,
        eventStartLine
      )
      currentSegment.rangeEndLineExclusive = Math.max(
        currentSegment.rangeEndLineExclusive,
        eventEndLineExclusivePostChange
      )

      // Read the lines from the changes associated with the updated segment.
      // We must do it on each update since the document at this point was already updated.
      // Is not very efficient, we are aware of it.
      currentSegment.textContent = this.readLinesFromDocument(
        currentSegment.rangeStartLine,
        currentSegment.rangeEndLineExclusive,
        currentDocument
      )
    }

    return closedSegments
  }

  private shouldSegmentForDocumentBeClosed(
    segment: Segment,
    cfg: SegmenterConfig
  ): boolean {
    const lastChangeAt =
      this.lastDocumentChangeAt.get(segment.documentUri) ?? cfg.now
    // If a segment has been idle for too long (since last edit) or has long text, we close it.
    // This allows us to keep uploaded segments reasonably fresh and bounded in size.
    return (
      cfg.now - lastChangeAt >= cfg.maxSegmentDurationMs ||
      segment.textContent.length >= cfg.maxSegmentChars
    )
  }

  private readLinesFromDocument(
    startLine: number,
    endLineExclusive: number,
    doc: vscode.TextDocument
  ): string {
    let changedLines: string = ''
    // Read all lines in the contiguous segment span [startLine, endLine)
    for (let lineNum = startLine; lineNum < endLineExclusive; lineNum++) {
      try {
        const line = doc.lineAt(lineNum)
        // From the docs: `line.text = The text of this line without the line separator characters`
        changedLines += `${line.text}\n`
      } catch {
        // Skip lines that no longer exist (document may have changed since segment closed)
      }
    }
    return changedLines
  }

  closeSegmentByDocURI(documentUri: string): Segment | undefined {
    const currentOpenSegment = this.currentOpenSegments.get(documentUri)
    if (!currentOpenSegment) {
      return undefined
    }
    return this.closeSegment(currentOpenSegment, documentUri)
  }

  private closeSegmentAndOpenNewOne({
    segmentToClose,
    document,
    rangeStartLine,
    rangeEndLineExclusive,
    startedAt,
  }: {
    segmentToClose: Segment
    document: vscode.TextDocument
    rangeStartLine: number
    rangeEndLineExclusive: number
    startedAt: number
  }): Segment {
    const closedSegment = this.closeSegment(
      segmentToClose,
      document.uri.toString()
    )
    this.createOpenSegment(
      document,
      rangeStartLine,
      rangeEndLineExclusive,
      startedAt
    )
    return closedSegment
  }

  private closeSegment(segment: Segment, docUriAsKey: string): Segment {
    const lastChangeAt =
      this.lastDocumentChangeAt.get(docUriAsKey) ?? segment.startedAt
    this.currentOpenSegments.delete(segment.documentUri)
    this.lastDocumentChangeAt.delete(segment.documentUri)
    return {
      closed: true,
      documentUri: segment.documentUri,
      fileName: segment.fileName,
      rangeStartLine: segment.rangeStartLine,
      rangeEndLineExclusive: segment.rangeEndLineExclusive,
      startedAt: segment.startedAt,
      endedAt: lastChangeAt,
      textContent: segment.textContent,
    }
  }

  private createOpenSegment(
    document: vscode.TextDocument,
    rangeStartLine: number,
    rangeEndLineExclusive: number,
    startedAt: number
  ): Segment {
    const textContent = this.readLinesFromDocument(
      rangeStartLine,
      rangeEndLineExclusive,
      document
    )
    const newSegment = {
      closed: false,
      documentUri: document.uri.toString(),
      fileName: document.fileName,
      rangeStartLine,
      rangeEndLineExclusive,
      startedAt,
      endedAt: startedAt,
      textContent,
    }
    this.currentOpenSegments.set(document.uri.toString(), newSegment)
    this.lastDocumentChangeAt.set(document.uri.toString(), startedAt)

    return newSegment
  }
}
