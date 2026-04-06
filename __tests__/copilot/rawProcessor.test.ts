import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  advanceCursor,
  cleanupStaleCursors,
  createEmptyState,
  processLines,
  readNewLines,
  readSessionId,
} from '../../src/copilot/rawProcessor'

vi.mock('vscode', () => ({}))

vi.mock('../../src/shared/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}))

const { mockConfigStore } = vi.hoisted(() => ({
  mockConfigStore: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    all: {} as Record<string, unknown>,
  },
}))
vi.mock('../../src/mobbdev_src/utils/ConfigStoreService', () => ({
  configStore: mockConfigStore,
}))

const { mockFsOpen, mockFsStat } = vi.hoisted(() => ({
  mockFsOpen: vi.fn(),
  mockFsStat: vi.fn(),
}))
vi.mock('node:fs/promises', () => ({
  open: mockFsOpen,
  stat: mockFsStat,
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockConfigStore.get.mockReturnValue(undefined)
})

// ---------------------------------------------------------------------------
// Helpers: build JSONL lines matching real Copilot format
// ---------------------------------------------------------------------------

function kind0Line(sessionId: string, requests?: unknown[]): string {
  return JSON.stringify({
    kind: 0,
    v: { sessionId, requests: requests ?? [] },
  })
}

function kind1Line(path: (string | number)[], value: unknown): string {
  return JSON.stringify({ kind: 1, k: path, v: value })
}

function kind2Line(requests: unknown[]): string {
  return JSON.stringify({ kind: 2, v: requests })
}

function makeRequest(
  requestId: string,
  opts: {
    modelId?: string
    text?: string
    response?: unknown[]
    result?: unknown
    modelState?: { value?: number; completedAt?: number }
  } = {}
): Record<string, unknown> {
  return {
    requestId,
    modelId: opts.modelId ?? 'copilot/gpt-5.3-codex',
    message: { text: opts.text ?? 'test prompt' },
    response: opts.response ?? [{ value: 'hello' }],
    result: opts.result ?? null,
    modelState: opts.modelState ?? {},
  }
}

// ---------------------------------------------------------------------------
// processLines
// ---------------------------------------------------------------------------

describe('processLines', () => {
  it('extracts sessionId from kind:0', () => {
    const state = createEmptyState()
    const lines = [kind0Line('session-abc')]
    processLines(lines, state)
    expect(state.sessionId).toBe('session-abc')
  })

  it('seeds requests from kind:0 v.requests', () => {
    const state = createEmptyState()
    const req = makeRequest('req-1', { text: 'hello world' })
    const lines = [kind0Line('s1', [req])]
    processLines(lines, state)
    expect(state.requestData.size).toBe(1)
    expect(state.appearanceOrder[0]).toBe('req-1')
  })

  it('returns completed requests (modelState.value === 1)', () => {
    const state = createEmptyState()
    const req = makeRequest('req-1', {
      response: [{ value: 'code here' }],
      modelState: { value: 1, completedAt: 1234567890 },
    })
    const lines = [kind0Line('s1', [req])]
    const { records } = processLines(lines, state)
    expect(records).toHaveLength(1)
    expect(records[0].request.requestId).toBe('req-1')
    expect(records[0].metadata.sessionId).toBe('s1')
  })

  it('defers incomplete requests (no modelState.completedAt)', () => {
    const state = createEmptyState()
    const req = makeRequest('req-1', {
      response: [{ value: 'partial' }],
      modelState: { value: 0 },
    })
    const lines = [kind0Line('s1', [req])]
    const { records } = processLines(lines, state)
    expect(records).toHaveLength(0)
  })

  it('skips cancelled requests (modelState.value === 2)', () => {
    const state = createEmptyState()
    const req = makeRequest('req-1', {
      response: [{ value: 'partial' }],
      modelState: { value: 2, completedAt: 1234567890 },
    })
    const lines = [kind0Line('s1', [req])]
    const { records } = processLines(lines, state)
    expect(records).toHaveLength(0)
  })

  it('skips requests with empty response', () => {
    const state = createEmptyState()
    const req = makeRequest('req-1', {
      response: [],
      modelState: { value: 1, completedAt: 1234567890 },
    })
    const lines = [kind0Line('s1', [req])]
    const { records } = processLines(lines, state)
    expect(records).toHaveLength(0)
  })

  it('applies kind:1 patches to result and modelState', () => {
    const state = createEmptyState()
    // First: seed request from kind:0
    const req = makeRequest('req-1', { response: [{ value: 'code' }] })
    const lines = [
      kind0Line('s1', [req]),
      // Then: kind:1 patches arrive
      kind1Line(['requests', 0, 'result'], { timings: { totalElapsed: 5000 } }),
      kind1Line(['requests', 0, 'modelState'], { value: 1, completedAt: 9999 }),
    ]
    const { records } = processLines(lines, state)
    expect(records).toHaveLength(1)
    expect(records[0].request.result).toEqual({
      timings: { totalElapsed: 5000 },
    })
  })

  it('updates response from kind:2 snapshot', () => {
    const state = createEmptyState()
    // Seed with kind:0
    const lines = [
      kind0Line('s1', [
        makeRequest('req-1', {
          response: [{ value: 'initial' }],
        }),
      ]),
      // kind:2 updates response
      kind2Line([
        {
          requestId: 'req-1',
          modelId: 'copilot/gpt-5.3-codex',
          message: { text: 'test' },
          response: [
            { value: 'updated' },
            { kind: 'toolInvocationSerialized' },
          ],
          modelState: { value: 1, completedAt: 1234 },
        },
      ]),
    ]
    const { records } = processLines(lines, state)
    expect(records).toHaveLength(1)
    expect(records[0].request.response).toHaveLength(2)
  })

  it('handles multi-turn: multiple requests complete across polls', () => {
    const state = createEmptyState()

    // Poll 1: first request completes
    const lines1 = [
      kind0Line('s1', [
        makeRequest('req-1', {
          response: [{ value: 'r1' }],
          modelState: { value: 1, completedAt: 1000 },
        }),
      ]),
    ]
    const { records: records1, emittedIds: ids1 } = processLines(lines1, state)
    expect(records1).toHaveLength(1)
    expect(records1[0].request.requestId).toBe('req-1')
    // Simulate successful upload — commit emitted IDs
    for (const id of ids1) {
      state.uploadedRequestIds.add(id)
    }

    // Poll 2: second request arrives via kind:2
    const lines2 = [
      kind2Line([
        {}, // req-1 placeholder
        makeRequest('req-2', {
          text: 'second prompt',
          response: [{ value: 'r2' }],
          modelState: { value: 1, completedAt: 2000 },
        }),
      ]),
    ]
    const { records: records2 } = processLines(lines2, state)
    expect(records2).toHaveLength(1)
    expect(records2[0].request.requestId).toBe('req-2')
  })

  it('does not re-emit already uploaded requests', () => {
    const state = createEmptyState()
    const req = makeRequest('req-1', {
      response: [{ value: 'code' }],
      modelState: { value: 1, completedAt: 1234 },
    })

    // First poll: emits the record
    const { records: records1, emittedIds: ids1 } = processLines(
      [kind0Line('s1', [req])],
      state
    )
    expect(records1).toHaveLength(1)
    // Simulate successful upload — commit emitted IDs
    for (const id of ids1) {
      state.uploadedRequestIds.add(id)
    }

    // Second poll: same data, should not re-emit
    const { records: records2 } = processLines([kind0Line('s1', [req])], state)
    expect(records2).toHaveLength(0)
  })

  it('filters empty placeholder requests from kind:2', () => {
    const state = createEmptyState()
    const lines = [
      kind0Line('s1'),
      kind2Line([
        {}, // empty placeholder
        { requestId: undefined }, // no requestId
        makeRequest('req-1', {
          response: [{ value: 'ok' }],
          modelState: { value: 1, completedAt: 5555 },
        }),
      ]),
    ]
    const { records } = processLines(lines, state)
    expect(records).toHaveLength(1)
    expect(records[0].request.requestId).toBe('req-1')
  })

  it('handles old format: kind:2 with complete request (response + result + modelState)', () => {
    const state = createEmptyState()
    const lines = [
      kind0Line('s1'),
      kind2Line([
        makeRequest('req-1', {
          response: [{ value: 'old format' }],
          result: { metadata: { toolCallRounds: [] } },
          modelState: { value: 1, completedAt: 3333 },
        }),
      ]),
    ]
    const { records } = processLines(lines, state)
    expect(records).toHaveLength(1)
    expect(records[0].request.result).toEqual({
      metadata: { toolCallRounds: [] },
    })
  })

  it('handles new format: kind:2 response only, kind:1 delivers result + modelState', () => {
    const state = createEmptyState()
    const lines = [
      kind0Line('s1', [
        makeRequest('req-1', {
          response: [],
          modelState: { value: 0 },
        }),
      ]),
      // kind:2 delivers response
      kind2Line([
        {
          requestId: 'req-1',
          response: [{ value: 'streaming...' }],
        },
      ]),
      // kind:1 delivers result + modelState
      kind1Line(['requests', 0, 'result'], { timings: { totalElapsed: 8000 } }),
      kind1Line(['requests', 0, 'modelState'], { value: 1, completedAt: 7777 }),
    ]
    const { records } = processLines(lines, state)
    expect(records).toHaveLength(1)
    expect(records[0].request.response).toEqual([{ value: 'streaming...' }])
  })

  it('handles kind:2 reindexing + kind:1 patches at original index', () => {
    const state = createEmptyState()
    // kind:0 seeds request at index 2 (there are requests 0,1,2)
    const lines = [
      kind0Line('s1', [
        makeRequest('req-0', {
          response: [],
          modelState: { value: 1, completedAt: 100 },
        }),
        makeRequest('req-1', {
          response: [],
          modelState: { value: 1, completedAt: 200 },
        }),
        makeRequest('req-2', {
          response: [{ value: 'streaming' }],
          modelState: { value: 0 },
        }),
      ]),
    ]
    processLines(lines, state)
    expect(state.requestData.size).toBe(3)
    expect(state.appearanceOrder).toEqual(['req-0', 'req-1', 'req-2'])

    // kind:2 snapshot puts req-2 at index 0 (reindexed) — data updates by requestId
    const lines2 = [
      kind2Line([
        {
          requestId: 'req-2',
          response: [{ value: 'updated' }],
          modelState: { value: 0 },
        },
      ]),
    ]
    processLines(lines2, state)
    // req-2 data should be updated regardless of kind:2 index
    expect(state.requestData.get('req-2')?.response).toEqual([
      { value: 'updated' },
    ])

    // kind:1 patches target original index 2 — matches appearance order position
    const lines3 = [
      kind1Line(['requests', 2, 'result'], { timings: { totalElapsed: 5000 } }),
      kind1Line(['requests', 2, 'modelState'], { value: 1, completedAt: 9999 }),
    ]
    const { records } = processLines(lines3, state)
    expect(records).toHaveLength(1)
    expect(records[0].request.requestId).toBe('req-2')
    expect(records[0].request.result).toEqual({
      timings: { totalElapsed: 5000 },
    })
  })

  it('eagerly collects first request when kind:2 replaces it with second request (single poll)', () => {
    const state = createEmptyState()
    // Simulates: prompt 1 completes, then kind:2 replaces index 0 with prompt 2, then prompt 2 completes
    const lines = [
      kind0Line('s1'),
      // kind:2 seeds request 1 at index 0
      kind2Line([
        makeRequest('req-1', {
          response: [{ value: 'r1' }],
          modelState: { value: 0 },
        }),
      ]),
      // kind:1 completes request 1
      kind1Line(['requests', 0, 'modelState'], { value: 1, completedAt: 1000 }),
      // kind:2 replaces index 0 with request 2
      kind2Line([
        makeRequest('req-2', {
          text: 'prompt 2',
          response: [{ value: 'r2' }],
          modelState: { value: 0 },
        }),
      ]),
      // kind:1 completes request 2 (at original index 1, but state has it at 0)
      kind1Line(['requests', 1, 'modelState'], { value: 1, completedAt: 2000 }),
    ]
    const { records } = processLines(lines, state)
    expect(records).toHaveLength(2)
    expect(records[0].request.requestId).toBe('req-1')
    expect(records[1].request.requestId).toBe('req-2')
  })

  it('ignores malformed JSON lines', () => {
    const state = createEmptyState()
    const lines = [
      'not valid json',
      kind0Line('s1', [
        makeRequest('req-1', {
          response: [{ value: 'ok' }],
          modelState: { value: 1, completedAt: 1111 },
        }),
      ]),
    ]
    const { records } = processLines(lines, state)
    expect(records).toHaveLength(1)
  })

  it('respects maxRecords cap', () => {
    const state = createEmptyState()
    const requests = Array.from({ length: 5 }, (_, i) =>
      makeRequest(`req-${i}`, {
        response: [{ value: `resp-${i}` }],
        modelState: { value: 1, completedAt: 1000 + i },
      })
    )
    const lines = [kind0Line('s1', requests)]
    const { records, emittedIds } = processLines(lines, state, 2)
    expect(records).toHaveLength(2)
    expect(emittedIds).toHaveLength(2)
    // uploadedRequestIds is not populated until caller commits
    expect(state.uploadedRequestIds.size).toBe(0)
  })

  it('emits stuck requests after timeout', () => {
    const state = createEmptyState()
    // Seed a request with response but no completedAt
    const req = makeRequest('req-stuck', {
      response: [{ value: 'partial output' }],
      modelState: { value: 0 },
    })
    const lines = [kind0Line('s1', [req])]
    processLines(lines, state)
    expect(state.requestData.has('req-stuck')).toBe(true)

    // Manually set firstSeenAt to 35 minutes ago (exceeds 30 min timeout)
    const entry = state.requestData.get('req-stuck')!
    entry.firstSeenAt = Date.now() - 35 * 60 * 1000

    // Process with empty lines — stuck detection happens during assembly
    const { records } = processLines([], state)
    expect(records).toHaveLength(1)
    expect(records[0].request.requestId).toBe('req-stuck')
  })

  it('emits plan mode completion (modelState.value === 3)', () => {
    const state = createEmptyState()
    const req = makeRequest('req-plan', {
      response: [{ value: 'plan output' }],
      modelState: { value: 3, completedAt: 9999 },
    })
    const lines = [kind0Line('s1', [req])]
    const { records } = processLines(lines, state)
    expect(records).toHaveLength(1)
    expect(records[0].request.requestId).toBe('req-plan')
    expect(records[0].metadata.sessionId).toBe('s1')
  })
})

// ---------------------------------------------------------------------------
// readNewLines
// ---------------------------------------------------------------------------

describe('readNewLines', () => {
  it('returns lines when file has grown since last read', async () => {
    const jsonlLine = JSON.stringify({ kind: 0, v: { sessionId: 'abc' } })
    const newBytes = Buffer.from(`${jsonlLine}\n`)

    mockConfigStore.get.mockReturnValue({
      byteOffset: 100,
      fileSize: 100,
      updatedAt: Date.now(),
    })
    mockFsStat.mockResolvedValue({ size: 100 + newBytes.length })

    const mockRead = vi.fn().mockResolvedValue({ bytesRead: newBytes.length })
    const mockClose = vi.fn().mockResolvedValue(undefined)
    mockFsOpen.mockResolvedValue({ read: mockRead, close: mockClose })

    // Mock read to fill the buffer with newBytes content
    mockRead.mockImplementation(
      (buffer: Buffer, _offset: number, _length: number, _position: number) => {
        newBytes.copy(buffer, 0)
        return Promise.resolve({ bytesRead: newBytes.length })
      }
    )

    const result = await readNewLines('/tmp/session.jsonl')
    expect(result.lines).toHaveLength(1)
    expect(result.newByteOffset).toBe(100 + newBytes.length)
    expect(result.newFileSize).toBe(100 + newBytes.length)
    expect(mockClose).toHaveBeenCalled()
  })

  it('returns empty lines when no new data', async () => {
    mockConfigStore.get.mockReturnValue({
      byteOffset: 500,
      fileSize: 500,
      updatedAt: Date.now(),
    })
    mockFsStat.mockResolvedValue({ size: 500 })

    const result = await readNewLines('/tmp/session.jsonl')
    expect(result.lines).toHaveLength(0)
    expect(result.newByteOffset).toBe(500)
    expect(result.newFileSize).toBe(500)
    expect(mockFsOpen).not.toHaveBeenCalled()
  })

  it('resets offset to 0 on file truncation', async () => {
    const fullContent = JSON.stringify({ kind: 0, v: { sessionId: 'new' } })
    const contentBuf = Buffer.from(`${fullContent}\n`)

    mockConfigStore.get.mockReturnValue({
      byteOffset: 1000,
      fileSize: 1000,
      updatedAt: Date.now(),
    })
    // File was truncated — size is smaller than stored offset
    mockFsStat.mockResolvedValue({ size: contentBuf.length })

    const mockRead = vi
      .fn()
      .mockImplementation(
        (
          buffer: Buffer,
          _offset: number,
          _length: number,
          _position: number
        ) => {
          contentBuf.copy(buffer, 0)
          return Promise.resolve({ bytesRead: contentBuf.length })
        }
      )
    const mockClose = vi.fn().mockResolvedValue(undefined)
    mockFsOpen.mockResolvedValue({ read: mockRead, close: mockClose })

    const result = await readNewLines('/tmp/session.jsonl')
    expect(result.lines).toHaveLength(1)
    // Should read from start (offset 0) to end
    expect(result.newByteOffset).toBe(contentBuf.length)
  })

  it('reads from byte 0 on first run (no stored cursor)', async () => {
    const content = JSON.stringify({ kind: 0, v: { sessionId: 'first' } })
    const contentBuf = Buffer.from(`${content}\n`)

    // No cursor stored
    mockConfigStore.get.mockReturnValue(undefined)
    mockFsStat.mockResolvedValue({ size: contentBuf.length })

    const mockRead = vi
      .fn()
      .mockImplementation(
        (
          buffer: Buffer,
          _offset: number,
          _length: number,
          _position: number
        ) => {
          contentBuf.copy(buffer, 0)
          return Promise.resolve({ bytesRead: contentBuf.length })
        }
      )
    const mockClose = vi.fn().mockResolvedValue(undefined)
    mockFsOpen.mockResolvedValue({ read: mockRead, close: mockClose })

    const result = await readNewLines('/tmp/session.jsonl')
    expect(result.lines).toHaveLength(1)
    expect(result.newByteOffset).toBe(contentBuf.length)
    // read should be called with position 0
    expect(mockRead).toHaveBeenCalledWith(
      expect.any(Buffer),
      0,
      contentBuf.length,
      0
    )
  })
})

// ---------------------------------------------------------------------------
// readSessionId
// ---------------------------------------------------------------------------

describe('readSessionId', () => {
  it('extracts sessionId from file header', async () => {
    const chunk = '{"kind":0,"v":{"sessionId":"abc-123","requests":[]}}'
    const chunkBuf = Buffer.from(chunk)

    const mockRead = vi
      .fn()
      .mockImplementation(
        (
          buffer: Buffer,
          _offset: number,
          length: number,
          _position: number
        ) => {
          chunkBuf.copy(buffer, 0, 0, Math.min(chunkBuf.length, length))
          return Promise.resolve({
            bytesRead: Math.min(chunkBuf.length, length),
          })
        }
      )
    const mockClose = vi.fn().mockResolvedValue(undefined)
    mockFsOpen.mockResolvedValue({ read: mockRead, close: mockClose })

    const result = await readSessionId('/tmp/session.jsonl')
    expect(result).toBe('abc-123')
    expect(mockClose).toHaveBeenCalled()
  })

  it('returns null when no sessionId found', async () => {
    const chunk = '{"kind":0,"v":{"requests":[]}}'
    const chunkBuf = Buffer.from(chunk)

    const mockRead = vi
      .fn()
      .mockImplementation(
        (
          buffer: Buffer,
          _offset: number,
          length: number,
          _position: number
        ) => {
          chunkBuf.copy(buffer, 0, 0, Math.min(chunkBuf.length, length))
          return Promise.resolve({
            bytesRead: Math.min(chunkBuf.length, length),
          })
        }
      )
    const mockClose = vi.fn().mockResolvedValue(undefined)
    mockFsOpen.mockResolvedValue({ read: mockRead, close: mockClose })

    const result = await readSessionId('/tmp/session.jsonl')
    expect(result).toBeNull()
  })

  it('returns null on file error', async () => {
    mockFsOpen.mockRejectedValue(new Error('ENOENT'))

    const result = await readSessionId('/tmp/nonexistent.jsonl')
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// advanceCursor
// ---------------------------------------------------------------------------

describe('advanceCursor', () => {
  it('stores byte offset and file size in configStore', () => {
    advanceCursor('/some/path/session.jsonl', 5000, 5000)
    expect(mockConfigStore.set).toHaveBeenCalledWith(
      expect.stringContaining('copilot.session.'),
      expect.objectContaining({
        byteOffset: 5000,
        fileSize: 5000,
        updatedAt: expect.any(Number),
      })
    )
  })
})

// ---------------------------------------------------------------------------
// cleanupStaleCursors
// ---------------------------------------------------------------------------

describe('cleanupStaleCursors', () => {
  it('deletes stale cursor keys older than 14 days', () => {
    const staleTime = Date.now() - 15 * 24 * 60 * 60 * 1000
    mockConfigStore.get.mockReturnValue(undefined) // no lastCleanupAt
    mockConfigStore.all = {
      copilot: {
        session: {
          abc123: {
            byteOffset: 100,
            fileSize: 100,
            updatedAt: staleTime,
          },
        },
      },
    }

    cleanupStaleCursors()
    expect(mockConfigStore.delete).toHaveBeenCalledWith(
      'copilot.session.abc123'
    )
    expect(mockConfigStore.set).toHaveBeenCalledWith(
      'copilot.lastCleanupAt',
      expect.any(Number)
    )
  })

  it('skips cleanup if last cleanup was recent', () => {
    mockConfigStore.get.mockReturnValue(Date.now() - 1000)
    cleanupStaleCursors()
    expect(mockConfigStore.delete).not.toHaveBeenCalled()
  })
})
