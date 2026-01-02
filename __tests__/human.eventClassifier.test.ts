import { describe, expect, it } from 'vitest'

import {
  detectEventClassification,
  EventShape,
} from '../src/human/eventClassifier'
import { EventClassification, isEventHuman } from '../src/human/types'

type FakeChange = { text: string }

type FakeEvent = {
  contentChanges: FakeChange[]
}

describe('detectEventClassification', () => {
  it('classifies empty events as EMPTY', () => {
    const event = { contentChanges: [] } as unknown as FakeEvent
    const res = detectEventClassification(event as unknown as EventShape)
    expect(res.eventClassification).toBe(EventClassification.EMPTY)
    expect(res.changeCount).toBe(0)
    expect(res.firstInsertSize).toBe(0)
  })

  it('classifies a single small change as SINGLE_CHANGE', () => {
    const event = {
      contentChanges: [{ text: 'abc' }],
    } as unknown as FakeEvent

    const res = detectEventClassification(event as unknown as EventShape)
    expect(res.eventClassification).toBe(EventClassification.SINGLE_CHANGE)
    expect(res.changeCount).toBe(1)
    expect(res.firstInsertSize).toBe(3)
  })

  it('classifies multi-change events as MULTI_CHANGE', () => {
    const event = {
      contentChanges: [
        {
          text: 'a',
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
        },
        {
          text: 'bcd',
          range: {
            start: { line: 5, character: 0 },
            end: { line: 5, character: 0 },
          },
        },
      ],
    } as unknown as FakeEvent

    const res = detectEventClassification(event as unknown as EventShape)
    expect(res.eventClassification).toBe(EventClassification.MULTI_CHANGE)
    expect(res.changeCount).toBe(2)
    expect(res.firstInsertSize).toBe(1)
  })

  it('classifies multi-line human edits as MULTI_LINE_SAME_CONTENT', () => {
    // Simulating commenting out lines 3, 4, 5 with "//"
    const event = {
      contentChanges: [
        {
          text: '//',
          range: {
            start: { line: 3, character: 0 },
            end: { line: 3, character: 0 },
          },
        },
        {
          text: '//',
          range: {
            start: { line: 4, character: 0 },
            end: { line: 4, character: 0 },
          },
        },
        {
          text: '//',
          range: {
            start: { line: 5, character: 0 },
            end: { line: 5, character: 0 },
          },
        },
      ],
    } as unknown as FakeEvent

    const res = detectEventClassification(event as unknown as EventShape)
    expect(res.eventClassification).toBe(
      EventClassification.MULTI_LINE_HUMAN_EDIT
    )
    expect(res.changeCount).toBe(3)
    expect(res.firstInsertSize).toBe(2)
  })

  it('classifies large single inserts as LARGE_INSERT', () => {
    // The concrete threshold comes from HUMAN_TRACKING_CONFIG.classifier,
    // we just need to ensure that sufficiently large inserts are routed
    // to the LARGE_INSERT classification.
    const event = {
      contentChanges: [{ text: 'x'.repeat(100) }],
    } as unknown as FakeEvent

    const res = detectEventClassification(event as unknown as EventShape)
    expect(res.eventClassification).toBe(EventClassification.LARGE_INSERT)
    expect(res.changeCount).toBe(1)
    expect(res.firstInsertSize).toBe(100)
  })

  it('classifies whitespace-only large inserts as WHITE_SPACE_INSERT', () => {
    // Enter key with auto-indentation can produce more than 10 chars of whitespace.
    // This should be classified as WHITE_SPACE_INSERT (human-like) not LARGE_INSERT.
    const event = {
      contentChanges: [{ text: `\r\n${' '.repeat(20)}` }], // 22 chars of whitespace
    } as unknown as FakeEvent

    const res = detectEventClassification(event as unknown as EventShape)
    expect(res.eventClassification).toBe(EventClassification.WHITE_SPACE_INSERT)
    expect(res.changeCount).toBe(1)
    expect(res.firstInsertSize).toBe(22)
  })

  it('classifies Enter with tabs as WHITE_SPACE_INSERT when exceeding threshold', () => {
    // Enter with tab indentation
    const event = {
      contentChanges: [{ text: `\n${'\t'.repeat(15)}` }], // 16 chars of whitespace
    } as unknown as FakeEvent

    const res = detectEventClassification(event as unknown as EventShape)
    expect(res.eventClassification).toBe(EventClassification.WHITE_SPACE_INSERT)
    expect(res.changeCount).toBe(1)
    expect(res.firstInsertSize).toBe(16)
  })

  it('classifies small whitespace as SINGLE_CHANGE (under threshold)', () => {
    // Enter with small indentation should still be SINGLE_CHANGE
    const event = {
      contentChanges: [{ text: '\r\n    ' }], // 6 chars, under 10 threshold
    } as unknown as FakeEvent

    const res = detectEventClassification(event as unknown as EventShape)
    expect(res.eventClassification).toBe(EventClassification.SINGLE_CHANGE)
    expect(res.changeCount).toBe(1)
    expect(res.firstInsertSize).toBe(6)
  })

  it('classifies mixed content as LARGE_INSERT even with whitespace', () => {
    // If there's any non-whitespace character, it should be LARGE_INSERT
    const event = {
      contentChanges: [{ text: `\n${' '.repeat(15)}x` }], // whitespace + one char
    } as unknown as FakeEvent

    const res = detectEventClassification(event as unknown as EventShape)
    expect(res.eventClassification).toBe(EventClassification.LARGE_INSERT)
    expect(res.changeCount).toBe(1)
    expect(res.firstInsertSize).toBe(17)
  })

  // Boundary tests for threshold (10 chars)
  it('classifies exactly 10 whitespace chars as SINGLE_CHANGE (at threshold)', () => {
    const event = {
      contentChanges: [{ text: ' '.repeat(10) }], // exactly at threshold, not over
    } as unknown as FakeEvent

    const res = detectEventClassification(event as unknown as EventShape)
    expect(res.eventClassification).toBe(EventClassification.SINGLE_CHANGE)
    expect(res.firstInsertSize).toBe(10)
  })

  it('classifies exactly 10 mixed whitespace chars as SINGLE_CHANGE (at threshold)', () => {
    // Verify boundary works with mixed whitespace types (newline + tabs + spaces)
    const event = {
      contentChanges: [{ text: '\n\t\t       ' }], // 1 newline + 2 tabs + 7 spaces = 10 chars, at threshold
    } as unknown as FakeEvent

    const res = detectEventClassification(event as unknown as EventShape)
    expect(res.eventClassification).toBe(EventClassification.SINGLE_CHANGE)
    expect(res.firstInsertSize).toBe(10)
  })

  it('classifies exactly 11 whitespace chars as WHITE_SPACE_INSERT (boundary)', () => {
    const event = {
      contentChanges: [{ text: ' '.repeat(11) }], // just over threshold
    } as unknown as FakeEvent

    const res = detectEventClassification(event as unknown as EventShape)
    expect(res.eventClassification).toBe(EventClassification.WHITE_SPACE_INSERT)
    expect(res.firstInsertSize).toBe(11)
  })

  it('classifies exactly 11 non-whitespace chars as LARGE_INSERT (boundary)', () => {
    const event = {
      contentChanges: [{ text: 'x'.repeat(11) }], // just over threshold, non-whitespace
    } as unknown as FakeEvent

    const res = detectEventClassification(event as unknown as EventShape)
    expect(res.eventClassification).toBe(EventClassification.LARGE_INSERT)
    expect(res.firstInsertSize).toBe(11)
  })

  // Unicode whitespace edge case tests
  it('classifies non-breaking space (U+00A0) as WHITE_SPACE_INSERT (matched by /\\s/)', () => {
    // Non-breaking space IS matched by JavaScript's \s regex pattern
    // This documents the expected behavior - Unicode whitespace is treated as human
    const nbsp = '\u00A0'
    const event = {
      contentChanges: [{ text: nbsp.repeat(15) }], // 15 non-breaking spaces
    } as unknown as FakeEvent

    const res = detectEventClassification(event as unknown as EventShape)
    expect(res.eventClassification).toBe(EventClassification.WHITE_SPACE_INSERT)
    expect(res.firstInsertSize).toBe(15)
  })

  it('classifies mixed ASCII and Unicode whitespace as WHITE_SPACE_INSERT', () => {
    // Mix of regular spaces and non-breaking spaces - all are whitespace
    const event = {
      contentChanges: [{ text: '     \u00A0\u00A0\u00A0\u00A0\u00A0     ' }], // 5 spaces + 5 nbsp + 5 spaces = 15 chars
    } as unknown as FakeEvent

    const res = detectEventClassification(event as unknown as EventShape)
    // All characters are whitespace (including nbsp), so it's WHITE_SPACE_INSERT
    expect(res.eventClassification).toBe(EventClassification.WHITE_SPACE_INSERT)
    expect(res.firstInsertSize).toBe(15)
  })
})

describe('isEventHuman', () => {
  it('returns true for SINGLE_CHANGE', () => {
    expect(isEventHuman(EventClassification.SINGLE_CHANGE)).toBe(true)
  })

  it('returns true for MULTI_LINE_HUMAN_EDIT', () => {
    expect(isEventHuman(EventClassification.MULTI_LINE_HUMAN_EDIT)).toBe(true)
  })

  it('returns true for WHITE_SPACE_INSERT', () => {
    expect(isEventHuman(EventClassification.WHITE_SPACE_INSERT)).toBe(true)
  })

  it('returns false for MULTI_CHANGE', () => {
    expect(isEventHuman(EventClassification.MULTI_CHANGE)).toBe(false)
  })

  it('returns false for LARGE_INSERT', () => {
    expect(isEventHuman(EventClassification.LARGE_INSERT)).toBe(false)
  })

  it('returns false for EMPTY', () => {
    expect(isEventHuman(EventClassification.EMPTY)).toBe(false)
  })
})
