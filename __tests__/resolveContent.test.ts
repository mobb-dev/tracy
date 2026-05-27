import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CursorRawRecord } from '../src/cursor/rawProcessor'
import { attachResolvedContent } from '../src/cursor/resolveContent'
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

beforeEach(() => {
  vi.clearAllMocks()
})

type MakeRecordOpts = {
  toolName?: string
  toolCallId?: string
  params?: Record<string, unknown> | string
  result?: Record<string, unknown> | string | null
  /** Pre-populate resolvedContent (simulates a record that was already resolved). */
  resolvedContent?: { after: string; before?: string }
}

const makeRecord = (opts: MakeRecordOpts = {}): CursorRawRecord => {
  const tfd: Record<string, unknown> = {
    name: opts.toolName ?? 'edit_file_v2',
    status: 'completed',
    toolCallId: opts.toolCallId ?? 'tc-1',
  }
  if (opts.params !== undefined) {
    tfd.params =
      typeof opts.params === 'string'
        ? opts.params
        : JSON.stringify(opts.params)
  }
  if (opts.result !== undefined && opts.result !== null) {
    tfd.result =
      typeof opts.result === 'string'
        ? opts.result
        : JSON.stringify(opts.result)
  }
  if (opts.resolvedContent) {
    tfd.resolvedContent = opts.resolvedContent
  }
  return {
    bubble: {
      type: 2,
      createdAt: '2026-05-15T10:00:00.000Z',
      toolFormerData: tfd,
    },
    metadata: {
      recordId: `rec-${opts.toolCallId ?? 'tc-1'}`,
      sessionId: 'session-1',
      model: 'composer-2.5',
    },
  }
}

const getResolved = (
  rec: CursorRawRecord
): { after?: string; before?: string } | undefined => {
  const tfd = (rec.bubble as { toolFormerData?: Record<string, unknown> })
    .toolFormerData
  return tfd?.resolvedContent as { after?: string; before?: string } | undefined
}

describe('attachResolvedContent', () => {
  it('legacy passthrough: no afterContentId → no worker call, record unchanged', async () => {
    const fetcher = vi.fn(async () => ({}))
    const records = [
      makeRecord({
        params: {
          relativeWorkspacePath: 'foo.ts',
          streamingContent: 'export const x = 1\n',
        },
        // No `result` — pure legacy
        result: null,
      }),
    ]
    await attachResolvedContent(records, fetcher)
    expect(fetcher).not.toHaveBeenCalled()
    expect(getResolved(records[0])).toBeUndefined()
  })

  it('non-v2 tool bubble: no worker call, record unchanged', async () => {
    const fetcher = vi.fn(async () => ({}))
    const records = [
      makeRecord({
        toolName: 'search_replace',
        result: {
          diff: { chunks: [{ diffString: '+ added line' }] },
        },
      }),
    ]
    await attachResolvedContent(records, fetcher)
    expect(fetcher).not.toHaveBeenCalled()
    expect(getResolved(records[0])).toBeUndefined()
  })

  it('happy path: both beforeContentId+afterContentId resolved', async () => {
    const fetcher = vi.fn(async () => ({
      'composer.content.bbb': 'before-content',
      'composer.content.aaa': 'after-content',
    }))
    const records = [
      makeRecord({
        result: {
          beforeContentId: 'composer.content.bbb',
          afterContentId: 'composer.content.aaa',
        },
      }),
    ]
    await attachResolvedContent(records, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const resolved = getResolved(records[0])
    expect(resolved).toEqual({
      after: 'after-content',
      before: 'before-content',
    })
  })

  it('new-file write: only afterContentId → no `before` key', async () => {
    const fetcher = vi.fn(async () => ({
      'composer.content.aaa': 'new-file-body',
    }))
    const records = [
      makeRecord({ result: { afterContentId: 'composer.content.aaa' } }),
    ]
    await attachResolvedContent(records, fetcher)
    const resolved = getResolved(records[0])
    expect(resolved).toEqual({ after: 'new-file-body' })
    expect(resolved).not.toHaveProperty('before')
  })

  it('missing row: afterContentId not in returned map → bubble untouched', async () => {
    const fetcher = vi.fn(async () => ({})) // empty result
    const records = [
      makeRecord({ result: { afterContentId: 'composer.content.zzz' } }),
    ]
    await attachResolvedContent(records, fetcher)
    expect(getResolved(records[0])).toBeUndefined()
  })

  it('oversize row: after.length > MAX_CONTENT_BYTES → skipped, debug logged', async () => {
    const big = 'x'.repeat(20 * 1024 * 1024 + 1) // 20MB + 1 byte
    const fetcher = vi.fn(async () => ({ 'composer.content.big': big }))
    const records = [
      makeRecord({
        toolCallId: 'tc-oversize',
        result: { afterContentId: 'composer.content.big' },
      }),
    ]
    await attachResolvedContent(records, fetcher)
    expect(getResolved(records[0])).toBeUndefined()
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: 'tc-oversize',
        byteSize: big.length,
      }),
      expect.stringContaining('oversize')
    )
  })

  it('worker throws: records untouched, single error logged with all affected toolCallIds, failed list returned for retry', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('SQLITE_BUSY: database is locked')
    })
    const records = [
      makeRecord({
        toolCallId: 'tc-A',
        result: { afterContentId: 'composer.content.aaa' },
      }),
      makeRecord({
        toolCallId: 'tc-B',
        result: { afterContentId: 'composer.content.bbb' },
      }),
    ]
    const result = await attachResolvedContent(records, fetcher)
    // Records are left untouched so they're not shipped with null content.
    expect(getResolved(records[0])).toBeUndefined()
    expect(getResolved(records[1])).toBeUndefined()
    // Caller receives the failed list so it can re-queue via incompleteBubbles
    // — protects against the rowid cursor advancing past these bubbles.
    expect(result.failed).toHaveLength(2)
    expect(result.failed.map((f) => f.toolCallId).sort()).toEqual([
      'tc-A',
      'tc-B',
    ])
    // Single structured error log with all affected toolCallIds in context
    // (not one warn per record — that would regress T-513's log volume cuts).
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        affectedRecords: 2,
        affectedToolCallIds: expect.arrayContaining(['tc-A', 'tc-B']),
      }),
      expect.stringContaining('re-queued for retry')
    )
    // No per-record warn fan-out.
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('malformed result JSON: no fetcher call, no crash, debug logged with toolCallId', async () => {
    const fetcher = vi.fn(async () => ({}))
    const records = [
      makeRecord({
        toolCallId: 'tc-malformed',
        result: 'this is not json {',
      }),
    ]
    await attachResolvedContent(records, fetcher)
    expect(fetcher).not.toHaveBeenCalled()
    expect(getResolved(records[0])).toBeUndefined()
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: 'tc-malformed' }),
      expect.stringContaining('failed to parse bubble result JSON')
    )
  })

  it('non-string afterContentId: record skipped, no fetcher call (would crash worker stmt.all bind)', async () => {
    const fetcher = vi.fn(async () => ({}))
    const records = [
      makeRecord({
        toolCallId: 'tc-bogus',
        // Number where a string was expected — passes truthy check but would
        // crash SQLite parameter binding. Helper must drop the record
        // before reaching the worker.
        result: { afterContentId: 42 as unknown as string },
      }),
    ]
    await attachResolvedContent(records, fetcher)
    expect(fetcher).not.toHaveBeenCalled()
    expect(getResolved(records[0])).toBeUndefined()
  })

  it('before-only oversize: after attached, before omitted (does not corrupt or drop the record)', async () => {
    const big = 'x'.repeat(20 * 1024 * 1024 + 1)
    const fetcher = vi.fn(async () => ({
      'composer.content.small-after': 'tiny',
      'composer.content.huge-before': big,
    }))
    const records = [
      makeRecord({
        toolCallId: 'tc-asym',
        result: {
          afterContentId: 'composer.content.small-after',
          beforeContentId: 'composer.content.huge-before',
        },
      }),
    ]
    await attachResolvedContent(records, fetcher)
    const resolved = getResolved(records[0])
    expect(resolved).toEqual({ after: 'tiny' })
    expect(resolved).not.toHaveProperty('before')
  })

  it('chunking boundary: >900 unique keys across one cycle still resolves correctly', async () => {
    // Defensive — our caller emits at most ~2 keys per bubble and a handful
    // of bubbles per cycle, so 900+ is unreachable today. This locks in the
    // worker-side chunking contract anyway.
    const N = 901 // one above MAX_IN_PARAMS
    const records: CursorRawRecord[] = []
    const contentMap: Record<string, string> = {}
    for (let i = 0; i < N; i++) {
      const aid = `composer.content.a${i}`
      contentMap[aid] = `content-${i}`
      records.push(
        makeRecord({
          toolCallId: `tc-${i}`,
          result: { afterContentId: aid },
        })
      )
    }
    const fetcher = vi.fn(async () => contentMap)
    await attachResolvedContent(records, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
    // Caller sends a single deduped Set to the worker; chunking happens
    // inside the worker, transparent to the helper.
    const passedKeys = fetcher.mock.calls[0]?.[0] as string[]
    expect(passedKeys).toHaveLength(N)
    for (let i = 0; i < N; i++) {
      expect(getResolved(records[i])).toEqual({ after: `content-${i}` })
    }
  })

  it('key dedup: same afterContentId on N bubbles → single key in SQL params', async () => {
    const fetcher = vi.fn(async () => ({
      'composer.content.shared': 'shared-content',
    }))
    const records = [
      makeRecord({
        toolCallId: 'tc-1',
        result: { afterContentId: 'composer.content.shared' },
      }),
      makeRecord({
        toolCallId: 'tc-2',
        result: { afterContentId: 'composer.content.shared' },
      }),
      makeRecord({
        toolCallId: 'tc-3',
        result: { afterContentId: 'composer.content.shared' },
      }),
    ]
    await attachResolvedContent(records, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const passedKeys = fetcher.mock.calls[0]?.[0] as string[]
    expect(passedKeys).toEqual(['composer.content.shared'])
    for (const r of records) {
      expect(getResolved(r)).toEqual({ after: 'shared-content' })
    }
  })

  it('mixed batch + order independence: legacy + new + missing + oversize across multiple bubbles → one fetch with deduped union; same result regardless of input order', async () => {
    const big = 'x'.repeat(20 * 1024 * 1024 + 1)
    const fetcher = vi.fn(async () => ({
      'composer.content.aaa': 'after-A',
      'composer.content.bbb': 'before-B',
      'composer.content.ccc': 'after-B',
      'composer.content.big': big,
      // 'composer.content.missing' deliberately not present
    }))

    const makeBatch = (): CursorRawRecord[] => [
      // Legacy: no contentId in result → no fetcher call
      makeRecord({
        toolCallId: 'legacy',
        params: { streamingContent: 'old style\n' },
        result: null,
      }),
      // Non-v2 tool
      makeRecord({
        toolCallId: 'sr',
        toolName: 'search_replace',
        result: { diff: { chunks: [{ diffString: '+ x' }] } },
      }),
      // New: afterId only
      makeRecord({
        toolCallId: 'new-A',
        result: { afterContentId: 'composer.content.aaa' },
      }),
      // New: both
      makeRecord({
        toolCallId: 'new-B',
        result: {
          beforeContentId: 'composer.content.bbb',
          afterContentId: 'composer.content.ccc',
        },
      }),
      // Missing
      makeRecord({
        toolCallId: 'miss',
        result: { afterContentId: 'composer.content.missing' },
      }),
      // Oversize
      makeRecord({
        toolCallId: 'big',
        result: { afterContentId: 'composer.content.big' },
      }),
    ]

    const batch1 = makeBatch()
    await attachResolvedContent(batch1, fetcher)

    // Reset and re-run with shuffled order
    vi.clearAllMocks()
    const batch2 = makeBatch().reverse()
    await attachResolvedContent(batch2, fetcher)

    expect(fetcher).toHaveBeenCalledTimes(1)
    const keys = (fetcher.mock.calls[0]?.[0] as string[]).slice().sort()
    expect(keys).toEqual(
      [
        'composer.content.aaa',
        'composer.content.bbb',
        'composer.content.ccc',
        'composer.content.big',
        'composer.content.missing',
      ].sort()
    )

    // Verify each batch yields the same per-toolCallId outcome
    const collect = (batch: CursorRawRecord[]) => {
      const out: Record<string, unknown> = {}
      for (const r of batch) {
        const tfd = (r.bubble as { toolFormerData?: { toolCallId?: string } })
          .toolFormerData
        out[tfd?.toolCallId ?? '?'] = getResolved(r) ?? null
      }
      return out
    }
    expect(collect(batch1)).toEqual(collect(batch2))
    expect(collect(batch1)).toEqual({
      legacy: null,
      sr: null,
      'new-A': { after: 'after-A' },
      'new-B': { after: 'after-B', before: 'before-B' },
      miss: null,
      big: null,
    })
  })
})
