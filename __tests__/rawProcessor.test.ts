import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DBRow } from '../src/cursor/db'
import {
  _resetKeyFormatWarnForTests,
  advanceCursor,
  cleanupStaleCursors,
  discoverActiveSessions,
  extractComposerIdFromKey,
  groupRecentKeysBySession,
  prepareSessionForUpload,
  revisitIncompleteBubbles,
} from '../src/cursor/rawProcessor'
import { logger } from '../src/shared/logger'

vi.mock('vscode', () => ({}))

vi.mock('../src/shared/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}))

// Mock configStore — use vi.hoisted to avoid hoisting issues
const { mockConfigStore } = vi.hoisted(() => ({
  mockConfigStore: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    all: {} as Record<string, unknown>,
  },
}))
vi.mock('../src/mobbdev_src/utils/ConfigStoreService', () => ({
  configStore: mockConfigStore,
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockConfigStore.get.mockReturnValue(undefined)
})

describe('discoverActiveSessions', () => {
  it('extracts unique composerIds from bubble keys', () => {
    const rows: DBRow[] = [
      { key: 'bubbleId:composer1:bubble1' },
      { key: 'bubbleId:composer1:bubble2' },
      { key: 'bubbleId:composer2:bubble3' },
    ]
    const sessions = discoverActiveSessions(rows)
    expect(sessions).toEqual(['composer1', 'composer2'])
  })

  it('returns empty for no rows', () => {
    expect(discoverActiveSessions([])).toEqual([])
  })

  it('handles malformed keys', () => {
    const rows: DBRow[] = [
      { key: 'bubbleId' }, // no composerId
      { key: 'bubbleId:composer1:bubble1' },
    ]
    const sessions = discoverActiveSessions(rows)
    expect(sessions).toEqual(['composer1'])
  })
})

describe('extractComposerIdFromKey', () => {
  it('returns the composerId for a well-formed key', () => {
    expect(extractComposerIdFromKey('bubbleId:composer1:bubble1')).toBe(
      'composer1'
    )
  })

  it('returns undefined for keys with too few segments', () => {
    expect(extractComposerIdFromKey('bubbleId')).toBeUndefined()
    expect(extractComposerIdFromKey('bubbleId:composer1')).toBeUndefined()
  })

  it('returns undefined when composerId segment is empty', () => {
    expect(extractComposerIdFromKey('bubbleId::bubble1')).toBeUndefined()
  })
})

describe('groupRecentKeysBySession', () => {
  beforeEach(() => {
    _resetKeyFormatWarnForTests()
  })

  it('groups keys by composerId and preserves insertion order', () => {
    const rows: DBRow[] = [
      { key: 'bubbleId:c1:b1' },
      { key: 'bubbleId:c2:b2' },
      { key: 'bubbleId:c1:b3' },
    ]
    const grouped = groupRecentKeysBySession(rows)
    expect(grouped.get('c1')).toEqual(['bubbleId:c1:b1', 'bubbleId:c1:b3'])
    expect(grouped.get('c2')).toEqual(['bubbleId:c2:b2'])
  })

  it('returns an empty map for no rows and does not warn', () => {
    const grouped = groupRecentKeysBySession([])
    expect(grouped.size).toBe(0)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('drops malformed keys and emits exactly one warning across calls', () => {
    const rows: DBRow[] = [
      { key: 'bubbleId' },
      { key: 'bubbleId:c1:b1' },
      { key: 'bogus' },
    ]
    groupRecentKeysBySession(rows)
    groupRecentKeysBySession(rows) // second call must NOT re-warn
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sampleKey: 'bubbleId' }),
      expect.stringContaining('Unexpected bubble-key format')
    )
  })
})

const makeBubble = (
  key: string,
  createdAt: string,
  toolStatus?: string
): DBRow => ({
  key,
  value: JSON.stringify({
    type: 2,
    createdAt,
    ...(toolStatus && {
      toolFormerData: {
        name: 'edit_file',
        status: toolStatus,
        toolCallId: `tc-${key}`,
      },
    }),
  }),
})

describe('prepareSessionForUpload', () => {
  it('returns all bubbles on first run (no cursor)', () => {
    const bubbles: DBRow[] = [
      makeBubble('bubbleId:c1:b1', '2024-01-01T00:00:00Z'),
      makeBubble('bubbleId:c1:b2', '2024-01-01T00:01:00Z'),
    ]
    const composerData = JSON.stringify({
      modelConfig: { modelName: 'gpt-4' },
    })

    const { records } = prepareSessionForUpload(bubbles, 'c1', composerData)
    expect(records).toHaveLength(2)
    expect(records[0].metadata.sessionId).toBe('c1')
    expect(records[0].metadata.model).toBe('gpt-4')
    expect(records[0].metadata.recordId).toBe('b1')
  })

  it('resumes from cursor position', () => {
    mockConfigStore.get.mockReturnValue({
      recordId: 'b1',
      timestamp: '2024-01-01T00:00:00Z',
      updatedAt: Date.now(),
    })

    const bubbles: DBRow[] = [
      makeBubble('bubbleId:c1:b1', '2024-01-01T00:00:00Z'),
      makeBubble('bubbleId:c1:b2', '2024-01-01T00:01:00Z'),
      makeBubble('bubbleId:c1:b3', '2024-01-01T00:02:00Z'),
    ]

    const { records } = prepareSessionForUpload(bubbles, 'c1', undefined)
    expect(records).toHaveLength(2)
    expect(records[0].metadata.recordId).toBe('b2')
  })

  it('skips non-terminal tool bubble and continues uploading', () => {
    const now = new Date().toISOString()
    const bubbles: DBRow[] = [
      makeBubble('bubbleId:c1:b1', now, 'completed'),
      makeBubble('bubbleId:c1:b2', now, 'running'), // non-terminal, skipped
      makeBubble('bubbleId:c1:b3', now, 'completed'),
    ]

    const { records, newIncomplete } = prepareSessionForUpload(
      bubbles,
      'c1',
      undefined
    )
    expect(records).toHaveLength(2) // b1 + b3 (b2 skipped)
    expect(records[0].metadata.recordId).toBe('b1')
    expect(records[1].metadata.recordId).toBe('b3')
    expect(newIncomplete).toHaveLength(1)
    expect(newIncomplete[0].key).toBe('bubbleId:c1:b2')
  })

  it('skips non-terminal tool and tracks as incomplete (not yet stuck)', () => {
    const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const bubbles: DBRow[] = [
      makeBubble('bubbleId:c1:b1', recentTime, 'running'), // 5 min, not stuck
      makeBubble('bubbleId:c1:b2', recentTime, 'completed'),
    ]

    const { records, newIncomplete } = prepareSessionForUpload(
      bubbles,
      'c1',
      undefined
    )
    expect(records).toHaveLength(1) // only b2
    expect(records[0].metadata.recordId).toBe('b2')
    expect(newIncomplete).toHaveLength(1)
    expect(newIncomplete[0].key).toBe('bubbleId:c1:b1')
  })

  it('handles missing composerData gracefully', () => {
    const bubbles: DBRow[] = [
      makeBubble('bubbleId:c1:b1', '2024-01-01T00:00:00Z'),
    ]

    const { records } = prepareSessionForUpload(bubbles, 'c1', undefined)
    expect(records).toHaveLength(1)
    expect(records[0].metadata.model).toBe('')
  })

  it('skips rows with no value', () => {
    const bubbles: DBRow[] = [
      { key: 'bubbleId:c1:b1' }, // no value
      makeBubble('bubbleId:c1:b2', '2024-01-01T00:01:00Z'),
    ]

    const { records } = prepareSessionForUpload(bubbles, 'c1', undefined)
    expect(records).toHaveLength(1)
    expect(records[0].metadata.recordId).toBe('b2')
  })

  it('output shape matches CursorRawData', () => {
    const bubbles: DBRow[] = [
      makeBubble('bubbleId:c1:b1', '2024-01-01T00:00:00Z'),
    ]
    const composerData = JSON.stringify({
      modelConfig: { modelName: 'claude-3.5-sonnet' },
    })

    const {
      records: [record],
    } = prepareSessionForUpload(bubbles, 'c1', composerData)
    expect(record).toEqual({
      bubble: expect.objectContaining({
        type: 2,
        createdAt: expect.any(String),
      }),
      metadata: {
        recordId: 'b1',
        sessionId: 'c1',
        model: 'claude-3.5-sonnet',
        rowid: undefined,
        bubblesFetched: 1,
      },
    })
  })
})

describe('revisitIncompleteBubbles', () => {
  it('uploads previously-incomplete bubble when now terminal', () => {
    const { records } = revisitIncompleteBubbles(
      [makeBubble('bubbleId:c1:b1', '2024-01-01T00:00:00Z', 'completed')],
      'c1',
      undefined
    )
    expect(records).toHaveLength(1)
    expect(records[0].metadata.recordId).toBe('b1')
  })

  it('force-uploads revisited bubble stuck >30 min', () => {
    // Set up cursor with an incomplete bubble first seen 31 min ago
    mockConfigStore.get.mockReturnValue({
      recordId: 'b0',
      timestamp: '2024-01-01T00:00:00Z',
      updatedAt: Date.now(),
      incompleteBubbles: [
        {
          key: 'bubbleId:c1:b1',
          firstSeenAt: Date.now() - 31 * 60 * 1000,
        },
      ],
    })

    const { records, stillIncomplete } = revisitIncompleteBubbles(
      [makeBubble('bubbleId:c1:b1', '2024-01-01T00:00:00Z', 'running')],
      'c1',
      undefined
    )
    expect(records).toHaveLength(1) // force-uploaded
    expect(stillIncomplete).toHaveLength(0)
  })
})

describe('advanceCursor', () => {
  it('stores cursor with rowid in configStore', () => {
    advanceCursor('c1', {
      recordId: 'b5',
      timestamp: '2024-01-01T00:05:00Z',
      lastRowId: 42,
    })
    expect(mockConfigStore.set).toHaveBeenCalledWith(
      'cursor.uploadCursor.c1',
      expect.objectContaining({
        recordId: 'b5',
        timestamp: '2024-01-01T00:05:00Z',
        updatedAt: expect.any(Number),
        lastRowId: 42,
      })
    )
  })
})

describe('cleanupStaleCursors', () => {
  it('deletes stale cursor keys older than 14 days', () => {
    const staleTime = Date.now() - 15 * 24 * 60 * 60 * 1000
    mockConfigStore.get.mockReturnValue(undefined) // no lastCleanupAt
    mockConfigStore.all = {
      cursor: {
        uploadCursor: {
          abc123: {
            recordId: 'b1',
            timestamp: '2024-01-01T00:00:00Z',
            updatedAt: staleTime,
          },
        },
      },
    }

    cleanupStaleCursors()
    expect(mockConfigStore.delete).toHaveBeenCalledWith(
      'cursor.uploadCursor.abc123'
    )
    expect(mockConfigStore.set).toHaveBeenCalledWith(
      'cursor.lastCleanupAt',
      expect.any(Number)
    )
  })

  it('skips cleanup if last cleanup was recent', () => {
    mockConfigStore.get.mockReturnValue(Date.now() - 1000) // recent
    cleanupStaleCursors()
    expect(mockConfigStore.delete).not.toHaveBeenCalled()
  })
})
