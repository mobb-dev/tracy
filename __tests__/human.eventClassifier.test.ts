import { describe, expect, it } from 'vitest'

import {
  detectEventClassification,
  EventShape,
} from '../src/human/eventClassifier'
import { EventClassification } from '../src/human/types'

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
})
