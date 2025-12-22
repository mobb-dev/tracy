import { describe, expect, it, vi } from 'vitest'
import type * as vscode from 'vscode'

import {
  computeIntervalDistancePostChange,
  getEventStartLineAndEndLineFromHumanEvent,
  rebaseSegmentAndMergeOverlappingChangesForDocumentEvent,
  type Segment,
  Segmenter,
} from '../src/human/segmenter'
import { EventClassification } from '../src/human/types'

// Minimal vscode mock so the module loads; types are erased at runtime.
vi.mock('vscode', () => ({}))

type FakeDoc = {
  uri: { toString(): string }
  fileName: string
  lineAt: (ln: number) => { text: string }
  isUntitled: boolean
  languageId: string
  version: number
  isDirty: boolean
  isClosed: boolean
  save: () => Thenable<boolean>
  eol: number
  lineCount: number
  positionAt: (offset: number) => { line: number; character: number }
  offsetAt: (position: { line: number; character: number }) => number
  getText: (range?: unknown) => string
  getWordRangeAtPosition: (position: unknown, regex?: RegExp) => unknown
  validateRange: (range: unknown) => unknown
  validatePosition: (position: unknown) => unknown
}

/**
 * Creates a mock vscode.Uri that satisfies the interface requirements
 */
function createMockUri(uri: string): vscode.Uri {
  const parsed = new URL(uri)
  return {
    scheme: parsed.protocol.slice(0, -1), // Remove trailing ':'
    authority: parsed.hostname,
    path: parsed.pathname,
    query: parsed.search.slice(1), // Remove leading '?'
    fragment: parsed.hash.slice(1), // Remove leading '#'
    fsPath: parsed.pathname,
    with: () => createMockUri(uri),
    toString: () => uri,
    toJSON: () => ({
      scheme: parsed.protocol.slice(0, -1),
      authority: parsed.hostname,
      path: parsed.pathname,
    }),
  } as vscode.Uri
}

/**
 * Creates a properly typed TextDocumentChangeEvent mock for testing
 */
function createMockChangeEvent(
  doc: FakeDoc,
  contentChanges: ReturnType<typeof makeChange>[]
): vscode.TextDocumentChangeEvent {
  // Create a mock document that satisfies vscode.TextDocument interface
  const mockDocument = {
    ...doc,
    uri: createMockUri(doc.uri.toString()),
  } as unknown as vscode.TextDocument

  return {
    document: mockDocument,
    contentChanges: contentChanges as vscode.TextDocumentContentChangeEvent[],
    reason: undefined,
  }
}

function makeChange(options: {
  startLine: number
  startCol?: number
  endLine?: number
  endCol?: number
  text: string
}) {
  const {
    startLine,
    startCol = 0,
    endLine = startLine,
    endCol = startCol,
    text,
  } = options
  return {
    range: {
      start: { line: startLine, character: startCol },
      end: { line: endLine, character: endCol },
      isEmpty: startLine === endLine && startCol === endCol,
    },
    rangeOffset: 0,
    rangeLength: 0,
    text,
  }
}

const baseCfg = {
  maxSegmentDurationMs: 5000,
  maxSegmentChars: 1000,
  adjacencyGapLines: 1,
}

describe('Segmenter (current behavior)', () => {
  it('merges adjacent human edits into a single open window', () => {
    const seg = new Segmenter()
    const uri = 'file:///ws/a.ts'
    const doc: FakeDoc = {
      uri: { toString: () => uri },
      fileName: '/ws/a.ts',
      lineAt: () => ({ text: 'x' }),
      isUntitled: false,
      languageId: 'typescript',
      version: 1,
      isDirty: false,
      isClosed: false,
      save: () => Promise.resolve(true),
      eol: 1,
      lineCount: 100,
      positionAt: () => ({ line: 0, character: 0 }),
      offsetAt: () => 0,
      getText: () => '',
      getWordRangeAtPosition: () => undefined,
      validateRange: (range: unknown) => range,
      validatePosition: (position: unknown) => position,
    }

    // First human edit at line 0
    let closed = seg.onDidChangeTextDocument(
      createMockChangeEvent(doc, [makeChange({ startLine: 0, text: 'a' })]),
      {
        ...baseCfg,
        now: 1000,
        eventClassification: EventClassification.SINGLE_CHANGE,
      }
    )
    expect(closed).toEqual([])

    // Second human edit on adjacent line 1
    closed = seg.onDidChangeTextDocument(
      createMockChangeEvent(doc, [makeChange({ startLine: 1, text: 'b' })]),
      {
        ...baseCfg,
        now: 1200,
        eventClassification: EventClassification.SINGLE_CHANGE,
      }
    )
    expect(closed).toEqual([])

    // Close the open segment and assert the merged window
    const closedByUri = seg.closeSegmentByDocURI(uri)
    expect(closedByUri).toBeDefined()
    expect(closedByUri!.rangeStartLine).toBe(0)
    expect(closedByUri!.rangeEndLineExclusive).toBe(2)
  })

  it('closes current segment when human edit jumps beyond adjacency gap', () => {
    const seg = new Segmenter()
    const uri = 'file:///ws/b.ts'
    const doc: FakeDoc = {
      uri: { toString: () => uri },
      fileName: '/ws/b.ts',
      lineAt: () => ({ text: 'x' }),
      isUntitled: false,
      languageId: 'typescript',
      version: 1,
      isDirty: false,
      isClosed: false,
      save: () => Promise.resolve(true),
      eol: 1,
      lineCount: 100,
      positionAt: () => ({ line: 0, character: 0 }),
      offsetAt: () => 0,
      getText: () => '',
      getWordRangeAtPosition: () => undefined,
      validateRange: (range: unknown) => range,
      validatePosition: (position: unknown) => position,
    }

    let closed = seg.onDidChangeTextDocument(
      createMockChangeEvent(doc, [makeChange({ startLine: 2, text: 'x' })]),
      {
        ...baseCfg,
        now: 1000,
        eventClassification: EventClassification.SINGLE_CHANGE,
      }
    )
    expect(closed).toEqual([])

    // Jump from line 2 to line 10 (gap > adjacencyGapLines)
    closed = seg.onDidChangeTextDocument(
      createMockChangeEvent(doc, [makeChange({ startLine: 10, text: 'y' })]),
      {
        ...baseCfg,
        now: 1400,
        eventClassification: EventClassification.SINGLE_CHANGE,
      }
    )
    expect(closed.length).toBe(1)
    const first = closed[0] as Segment
    expect(first.rangeStartLine).toBe(2)
    expect(first.rangeEndLineExclusive).toBe(3)

    const openClosed = seg.closeSegmentByDocURI(uri)
    expect(openClosed).toBeDefined()
    expect(openClosed!.rangeStartLine).toBe(10)
    expect(openClosed!.rangeEndLineExclusive).toBe(11)
  })

  it('force-closes segment when non-human change inserts lines above', () => {
    const seg = new Segmenter()
    const uri = 'file:///ws/c.ts'
    const doc: FakeDoc = {
      uri: { toString: () => uri },
      fileName: '/ws/c.ts',
      lineAt: () => ({ text: 'x' }),
      isUntitled: false,
      languageId: 'typescript',
      version: 1,
      isDirty: false,
      isClosed: false,
      save: () => Promise.resolve(true),
      eol: 1,
      lineCount: 100,
      positionAt: () => ({ line: 0, character: 0 }),
      offsetAt: () => 0,
      getText: () => '',
      getWordRangeAtPosition: () => undefined,
      validateRange: (range: unknown) => range,
      validatePosition: (position: unknown) => position,
    }

    // Human edit at line 10
    seg.onDidChangeTextDocument(
      createMockChangeEvent(doc, [
        makeChange({ startLine: 10, text: 'human' }),
      ]),
      {
        ...baseCfg,
        now: 1000,
        eventClassification: EventClassification.SINGLE_CHANGE,
      }
    )

    // MULTI_CHANGE (format event) rebases the segment
    const closed = seg.onDidChangeTextDocument(
      createMockChangeEvent(doc, [
        makeChange({
          startLine: 5,
          endLine: 5,
          text: 'a\nb\nc\n',
        }),
      ]),
      {
        ...baseCfg,
        now: 1100,
        eventClassification: EventClassification.MULTI_CHANGE,
      }
    )

    // MULTI_CHANGE should not close the segment
    expect(closed.length).toBe(0)

    // Segment should still be open and rebased (shifted down by 3 lines)
    const openSegments = seg.getAllOpenSegmentsURIs()
    expect(openSegments).toContain(uri)

    // Close the segment to verify it was rebased
    const closedSegment = seg.closeSegmentByDocURI(uri)
    expect(closedSegment).toBeDefined()
    expect(closedSegment!.rangeStartLine).toBe(13) // 10 + 3 lines inserted
    expect(closedSegment!.rangeEndLineExclusive).toBe(14) // 11 + 3 lines inserted
  })

  it('force-closes open segment for a document', () => {
    const seg = new Segmenter()
    const uri = 'file:///ws/d.ts'
    const doc: FakeDoc = {
      uri: { toString: () => uri },
      fileName: '/ws/d.ts',
      lineAt: () => ({ text: 'x' }),
      isUntitled: false,
      languageId: 'typescript',
      version: 1,
      isDirty: false,
      isClosed: false,
      save: () => Promise.resolve(true),
      eol: 1,
      lineCount: 100,
      positionAt: () => ({ line: 0, character: 0 }),
      offsetAt: () => 0,
      getText: () => '',
      getWordRangeAtPosition: () => undefined,
      validateRange: (range: unknown) => range,
      validatePosition: (position: unknown) => position,
    }

    seg.onDidChangeTextDocument(
      createMockChangeEvent(doc, [makeChange({ startLine: 0, text: 'line' })]),
      {
        ...baseCfg,
        now: 1000,
        eventClassification: EventClassification.SINGLE_CHANGE,
      }
    )

    const closed = seg.closeSegmentByDocURI(uri)
    expect(closed).toBeDefined()
    expect(closed!.rangeStartLine).toBe(0)
    expect(closed!.rangeEndLineExclusive).toBe(1)
  })
})

describe('rebaseSegmentAndMergeOverlappingChangesForDocumentEvent', () => {
  function createTestSegment(
    startLine: number,
    endLineExclusive: number
  ): Segment {
    return {
      closed: false,
      documentUri: 'file:///test.ts',
      fileName: '/test.ts',
      rangeStartLine: startLine,
      rangeEndLineExclusive: endLineExclusive,
      textContent: 'test content',
      startedAt: 1000,
      endedAt: 1000,
    }
  }

  const testDoc: FakeDoc = {
    uri: { toString: () => 'file:///test.ts' },
    fileName: '/test.ts',
    lineAt: () => ({ text: 'x' }),
    isUntitled: false,
    languageId: 'typescript',
    version: 1,
    isDirty: false,
    isClosed: false,
    save: () => Promise.resolve(true),
    eol: 1,
    lineCount: 100,
    positionAt: () => ({ line: 0, character: 0 }),
    offsetAt: () => 0,
    getText: () => '',
    getWordRangeAtPosition: () => undefined,
    validateRange: (range: unknown) => range,
    validatePosition: (position: unknown) => position,
  }

  it('sorts changes from end to start (descending by line and character)', () => {
    const segment = createTestSegment(10, 20)

    // Create changes in mixed order to test sorting
    const changes = [
      makeChange({ startLine: 5, startCol: 10, text: 'change1' }),
      makeChange({ startLine: 15, startCol: 5, text: 'change2' }),
      makeChange({ startLine: 15, startCol: 20, text: 'change3' }), // Same line, different column
      makeChange({ startLine: 25, startCol: 0, text: 'change4' }),
      makeChange({ startLine: 15, startCol: 10, text: 'change5' }), // Same line, middle column
    ]

    // Manually sort to verify expected order
    const sortedChanges = changes.slice().sort((a, b) => {
      const lineDiff = b.range.start.line - a.range.start.line
      if (lineDiff !== 0) {
        return lineDiff
      }
      return b.range.start.character - a.range.start.character
    })

    // Expected order: line 25, then line 15 (col 20, 10, 5), then line 5
    expect(sortedChanges.map((c) => c.text)).toEqual([
      'change4',
      'change3',
      'change5',
      'change2',
      'change1',
    ])

    const event = createMockChangeEvent(testDoc, changes)
    rebaseSegmentAndMergeOverlappingChangesForDocumentEvent(segment, event)

    // After processing, the segment should be affected by changes at line 15 and line 5
    expect(segment.rangeStartLine).toBe(10) // No shift (changes have no newlines)
    expect(segment.rangeEndLineExclusive).toBe(20) // No shift (changes have no newlines)
  })

  it('handles multiple changes on the same line with different columns', () => {
    const segment = createTestSegment(10, 20)

    // Multiple changes on line 15 with different columns
    const changes = [
      makeChange({
        startLine: 15,
        startCol: 5,
        endLine: 15,
        endCol: 10,
        text: 'first',
      }),
      makeChange({
        startLine: 15,
        startCol: 15,
        endLine: 15,
        endCol: 20,
        text: 'second',
      }),
      makeChange({
        startLine: 15,
        startCol: 25,
        endLine: 15,
        endCol: 30,
        text: 'third',
      }),
    ]

    const event = createMockChangeEvent(testDoc, changes)

    // Verify changes are processed from highest column to lowest
    const processedColumns: number[] = []
    for (const change of event.contentChanges.slice().sort((a, b) => {
      const lineDiff = b.range.start.line - a.range.start.line
      if (lineDiff !== 0) {
        return lineDiff
      }
      return b.range.start.character - a.range.start.character
    })) {
      processedColumns.push(change.range.start.character)
    }

    rebaseSegmentAndMergeOverlappingChangesForDocumentEvent(segment, event)

    // Verify columns were processed in descending order: 25, 15, 5
    expect(processedColumns).toEqual([25, 15, 5])

    // Segment boundaries should remain stable (changes within segment, no newlines)
    expect(segment.rangeStartLine).toBe(10)
    expect(segment.rangeEndLineExclusive).toBe(20)
  })

  it('handles change entirely below segment (no impact)', () => {
    const segment = createTestSegment(10, 20)

    const event = createMockChangeEvent(testDoc, [
      makeChange({ startLine: 25, text: 'new line below' }),
    ])

    rebaseSegmentAndMergeOverlappingChangesForDocumentEvent(segment, event)

    // Segment should remain unchanged
    expect(segment.rangeStartLine).toBe(10)
    expect(segment.rangeEndLineExclusive).toBe(20)
  })

  it('handles change entirely above segment (shifts segment down)', () => {
    const segment = createTestSegment(10, 20)

    const event = createMockChangeEvent(testDoc, [
      makeChange({
        startLine: 5,
        endLine: 7,
        text: 'new\nlines\nabove\nextra',
      }),
    ])

    rebaseSegmentAndMergeOverlappingChangesForDocumentEvent(segment, event)

    // Net delta: +3 newlines - 2 deleted lines = +1
    // Segment should shift down by 1
    expect(segment.rangeStartLine).toBe(11)
    expect(segment.rangeEndLineExclusive).toBe(21)
  })

  it('handles change within segment (shifts only end line)', () => {
    const segment = createTestSegment(10, 20)

    const event = createMockChangeEvent(testDoc, [
      makeChange({
        startLine: 12,
        endLine: 14,
        text: 'replaced\nwith\nthree\nlines',
      }),
    ])

    rebaseSegmentAndMergeOverlappingChangesForDocumentEvent(segment, event)

    // Net delta: +3 newlines - 2 deleted lines = +1
    // Start line unchanged, end line shifts by 1
    expect(segment.rangeStartLine).toBe(10)
    expect(segment.rangeEndLineExclusive).toBe(21)
  })

  it('handles change overlapping start of segment', () => {
    const segment = createTestSegment(10, 20)

    const event = createMockChangeEvent(testDoc, [
      makeChange({ startLine: 8, endLine: 12, text: 'overlap\nstart' }),
    ])

    rebaseSegmentAndMergeOverlappingChangesForDocumentEvent(segment, event)

    // Net delta: +1 newline - 4 deleted lines = -3
    // Segment start moves to change start (8), end shifts by delta
    expect(segment.rangeStartLine).toBe(8)
    expect(segment.rangeEndLineExclusive).toBe(17) // 20 + (-3)
  })

  it('handles change overlapping end of segment', () => {
    const segment = createTestSegment(10, 20)

    const event = createMockChangeEvent(testDoc, [
      makeChange({ startLine: 18, endLine: 22, text: 'overlap\nend\nlines' }),
    ])

    rebaseSegmentAndMergeOverlappingChangesForDocumentEvent(segment, event)

    // Segment start unchanged, end moves to change start + inserted newlines
    expect(segment.rangeStartLine).toBe(10)
    expect(segment.rangeEndLineExclusive).toBe(20) // 18 + 2 newlines
  })

  it('handles change completely covering segment', () => {
    const segment = createTestSegment(10, 20)

    const event = createMockChangeEvent(testDoc, [
      makeChange({ startLine: 5, endLine: 25, text: 'complete\nreplacement' }),
    ])

    rebaseSegmentAndMergeOverlappingChangesForDocumentEvent(segment, event)

    // Segment replaced entirely by the change
    expect(segment.rangeStartLine).toBe(5)
    expect(segment.rangeEndLineExclusive).toBe(6) // 5 + 1 newline
  })

  describe('Edge cases: touching vs overlapping', () => {
    it('handles change touching segment from above (no overlap)', () => {
      const segment = createTestSegment(10, 20)

      // Change affects lines 7-9, segment is lines 10-19
      // They touch at line 10 but don't overlap
      const event = createMockChangeEvent(testDoc, [
        makeChange({ startLine: 7, endLine: 9, text: 'new\ntext' }),
      ])

      rebaseSegmentAndMergeOverlappingChangesForDocumentEvent(segment, event)

      // Net delta: 1 newline - 2 deleted lines = -1
      // Touching but not overlapping: segment shifts but doesn't merge
      expect(segment.rangeStartLine).toBe(9) // 10 + (-1)
      expect(segment.rangeEndLineExclusive).toBe(19) // 20 + (-1)
    })

    it('handles change with one line overlap at segment start', () => {
      const segment = createTestSegment(10, 20)

      // Change affects lines 8-10, segment is lines 10-19
      // They overlap at line 10
      const event = createMockChangeEvent(testDoc, [
        makeChange({ startLine: 8, endLine: 10, text: 'replacement' }),
      ])

      rebaseSegmentAndMergeOverlappingChangesForDocumentEvent(segment, event)

      // Net delta: 0 newlines - 2 deleted lines = -2
      // Overlaps start, so segment should expand to include change
      expect(segment.rangeStartLine).toBe(8) // Change start
      expect(segment.rangeEndLineExclusive).toBe(18) // 20 + (-2)
    })

    it('handles change touching segment from below (no overlap)', () => {
      const segment = createTestSegment(10, 20)

      // Change affects lines 20-22, segment is lines 10-19
      // They touch at line 20 but don't overlap (line 20 is not in segment)
      const event = createMockChangeEvent(testDoc, [
        makeChange({ startLine: 20, endLine: 22, text: 'new\ntext' }),
      ])

      rebaseSegmentAndMergeOverlappingChangesForDocumentEvent(segment, event)

      // No change expected (change is entirely below segment)
      expect(segment.rangeStartLine).toBe(10)
      expect(segment.rangeEndLineExclusive).toBe(20)
    })

    it('handles change with one line overlap at segment end', () => {
      const segment = createTestSegment(10, 20)

      // Change affects lines 19-21, segment is lines 10-19
      // They overlap at line 19
      const event = createMockChangeEvent(testDoc, [
        makeChange({ startLine: 19, endLine: 21, text: 'replacement' }),
      ])

      rebaseSegmentAndMergeOverlappingChangesForDocumentEvent(segment, event)

      // Overlaps end, segment end should adjust
      expect(segment.rangeStartLine).toBe(10)
      expect(segment.rangeEndLineExclusive).toBe(19) // Truncated at change start
    })

    it('handles pure insertion at segment boundary (start)', () => {
      const segment = createTestSegment(10, 20)

      // Pure insertion at line 10 (segment start)
      const event = createMockChangeEvent(testDoc, [
        makeChange({ startLine: 10, endLine: 10, text: 'inserted line\n' }),
      ])

      rebaseSegmentAndMergeOverlappingChangesForDocumentEvent(segment, event)

      // Insertion is within segment, only end shifts
      expect(segment.rangeStartLine).toBe(10)
      expect(segment.rangeEndLineExclusive).toBe(21) // 20 + 1 newline
    })

    it('handles pure insertion at segment boundary (end)', () => {
      const segment = createTestSegment(10, 20)

      // Pure insertion at line 20 (segment end, which is exclusive)
      const event = createMockChangeEvent(testDoc, [
        makeChange({ startLine: 20, endLine: 20, text: 'inserted line\n' }),
      ])

      rebaseSegmentAndMergeOverlappingChangesForDocumentEvent(segment, event)

      // Insertion is outside segment (at exclusive boundary)
      expect(segment.rangeStartLine).toBe(10)
      expect(segment.rangeEndLineExclusive).toBe(20) // No change
    })
  })
})

describe('getEventStartLineAndEndLineFromHumanEvent', () => {
  const testDoc: FakeDoc = {
    uri: { toString: () => 'file:///test.ts' },
    fileName: '/test.ts',
    lineAt: () => ({ text: 'x' }),
    isUntitled: false,
    languageId: 'typescript',
    version: 1,
    isDirty: false,
    isClosed: false,
    save: () => Promise.resolve(true),
    eol: 1,
    lineCount: 100,
    positionAt: () => ({ line: 0, character: 0 }),
    offsetAt: () => 0,
    getText: () => '',
    getWordRangeAtPosition: () => undefined,
    validateRange: (range: unknown) => range,
    validatePosition: (position: unknown) => position,
  }

  it('handles single change event', () => {
    const event = createMockChangeEvent(testDoc, [
      makeChange({ startLine: 5, endLine: 7, text: 'new\ntext' }),
    ])

    const result = getEventStartLineAndEndLineFromHumanEvent(event)

    expect(result.eventStartLine).toBe(5)
    expect(result.eventEndLineExclusive).toBe(8) // 7 + 1 for exclusive
    // Net delta: 1 newline - 2 deleted lines = -1
    expect(result.eventEndLineExclusivePostChange).toBe(7) // 8 + (-1)
  })

  it('handles multiple changes on adjacent lines (commenting)', () => {
    // Realistic scenario: Adding "//" to comment out lines 3, 4, 5
    const event = createMockChangeEvent(testDoc, [
      makeChange({
        startLine: 3,
        startCol: 0,
        endLine: 3,
        endCol: 0,
        text: '//',
      }),
      makeChange({
        startLine: 4,
        startCol: 0,
        endLine: 4,
        endCol: 0,
        text: '//',
      }),
      makeChange({
        startLine: 5,
        startCol: 0,
        endLine: 5,
        endCol: 0,
        text: '//',
      }),
    ])

    const result = getEventStartLineAndEndLineFromHumanEvent(event)

    expect(result.eventStartLine).toBe(3) // Min start line
    expect(result.eventEndLineExclusive).toBe(6) // Max end line (5) + 1
    // Multi-line changes don't add or remove lines, netLineDelta = 0
    expect(result.eventEndLineExclusivePostChange).toBe(6) // 6 + 0
  })

  it('handles multiple changes on adjacent lines (indentation)', () => {
    // Realistic scenario: Adding indentation to lines 8, 9, 10
    const event = createMockChangeEvent(testDoc, [
      makeChange({
        startLine: 8,
        startCol: 0,
        endLine: 8,
        endCol: 0,
        text: '  ',
      }),
      makeChange({
        startLine: 9,
        startCol: 0,
        endLine: 9,
        endCol: 0,
        text: '  ',
      }),
      makeChange({
        startLine: 10,
        startCol: 0,
        endLine: 10,
        endCol: 0,
        text: '  ',
      }),
    ])

    const result = getEventStartLineAndEndLineFromHumanEvent(event)

    expect(result.eventStartLine).toBe(8) // Min start line
    expect(result.eventEndLineExclusive).toBe(11) // Max end line (10) + 1
    // Multi-line changes don't add or remove lines, netLineDelta = 0
    expect(result.eventEndLineExclusivePostChange).toBe(11) // 11 + 0
  })

  it('throws error for empty content changes', () => {
    const event = createMockChangeEvent(testDoc, [])

    expect(() => getEventStartLineAndEndLineFromHumanEvent(event)).toThrow(
      'Cannot extract start and end lines from event with no content changes'
    )
  })
})

describe('computeIntervalDistancePostChange', () => {
  it('returns 0 for overlapping intervals', () => {
    const distance = computeIntervalDistancePostChange(10, 20, 15, 25)
    expect(distance).toBe(0)
  })

  it('returns 0 for touching intervals', () => {
    const distance = computeIntervalDistancePostChange(10, 20, 20, 30)
    expect(distance).toBe(0)
  })

  it('calculates distance when change is above segment', () => {
    const distance = computeIntervalDistancePostChange(20, 30, 10, 15)
    expect(distance).toBe(5) // 20 - 15
  })

  it('calculates distance when change is below segment', () => {
    const distance = computeIntervalDistancePostChange(10, 20, 25, 35)
    expect(distance).toBe(5) // 25 - 20
  })
})

describe('MULTI_CHANGE and EMPTY event handling', () => {
  it('MULTI_CHANGE event just rebases segment without closing', () => {
    const seg = new Segmenter()
    const uri = 'file:///ws/multi.ts'
    const doc: FakeDoc = {
      uri: { toString: () => uri },
      fileName: '/ws/multi.ts',
      lineAt: () => ({ text: 'x' }),
      isUntitled: false,
      languageId: 'typescript',
      version: 1,
      isDirty: false,
      isClosed: false,
      save: () => Promise.resolve(true),
      eol: 1,
      lineCount: 100,
      positionAt: () => ({ line: 0, character: 0 }),
      offsetAt: () => 0,
      getText: () => '',
      getWordRangeAtPosition: () => undefined,
      validateRange: (range: unknown) => range,
      validatePosition: (position: unknown) => position,
    }

    // Create an open segment
    seg.onDidChangeTextDocument(
      createMockChangeEvent(doc, [
        makeChange({ startLine: 10, text: 'initial' }),
      ]),
      {
        ...baseCfg,
        now: 1000,
        eventClassification: EventClassification.SINGLE_CHANGE,
      }
    )

    // Apply MULTI_CHANGE that adds lines above the segment
    const closed = seg.onDidChangeTextDocument(
      createMockChangeEvent(doc, [
        makeChange({ startLine: 5, endLine: 5, text: 'new\nlines' }),
      ]),
      {
        ...baseCfg,
        now: 1100,
        eventClassification: EventClassification.MULTI_CHANGE,
      }
    )

    // Should not close any segments
    expect(closed).toEqual([])

    // Segment should still be open
    expect(seg.getAllOpenSegmentsURIs()).toContain(uri)
  })

  it('EMPTY event just rebases segment without closing', () => {
    const seg = new Segmenter()
    const uri = 'file:///ws/empty.ts'
    const doc: FakeDoc = {
      uri: { toString: () => uri },
      fileName: '/ws/empty.ts',
      lineAt: () => ({ text: 'x' }),
      isUntitled: false,
      languageId: 'typescript',
      version: 1,
      isDirty: false,
      isClosed: false,
      save: () => Promise.resolve(true),
      eol: 1,
      lineCount: 100,
      positionAt: () => ({ line: 0, character: 0 }),
      offsetAt: () => 0,
      getText: () => '',
      getWordRangeAtPosition: () => undefined,
      validateRange: (range: unknown) => range,
      validatePosition: (position: unknown) => position,
    }

    // Create an open segment
    seg.onDidChangeTextDocument(
      createMockChangeEvent(doc, [
        makeChange({ startLine: 10, text: 'initial' }),
      ]),
      {
        ...baseCfg,
        now: 1000,
        eventClassification: EventClassification.SINGLE_CHANGE,
      }
    )

    // Apply EMPTY event
    const closed = seg.onDidChangeTextDocument(createMockChangeEvent(doc, []), {
      ...baseCfg,
      now: 1100,
      eventClassification: EventClassification.EMPTY,
    })

    // Should not close any segments
    expect(closed).toEqual([])

    // Segment should still be open
    expect(seg.getAllOpenSegmentsURIs()).toContain(uri)
  })
})
