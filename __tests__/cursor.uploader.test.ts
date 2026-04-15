import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CursorRawRecord } from '../src/cursor/rawProcessor'
import { uploadCursorRawRecords } from '../src/shared/uploader'

vi.mock('vscode', () => ({
  workspace: { workspaceFolders: [] },
}))

vi.mock('../src/shared/repositoryInfo', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/shared/repositoryInfo')>()
  return {
    ...actual,
    getNormalizedRepo: vi.fn().mockResolvedValue({
      gitRepoUrl: 'https://github.com/test-org/test-repo',
      gitRoot: '/tmp/test-repo',
    }),
  }
})

const getConfigMock = vi.fn().mockReturnValue({
  apiUrl: 'https://api.mobb.ai/v1/graphql',
  webAppUrl: 'https://app.mobb.ai',
  extensionVersion: '0.1.0',
  sanitizeData: false,
})
vi.mock('../src/shared/config', () => ({
  getConfig: (...args: unknown[]) => getConfigMock(...args),
}))

// Mock the actual dependencies of uploadTracyRecords (same-module call)
const prepareAndSendMock = vi.fn().mockResolvedValue({ ok: true, errors: null })
vi.mock(
  '../src/mobbdev_src/features/analysis/graphql/tracy-batch-upload',
  () => ({
    prepareAndSendTracyRecords: (...args: unknown[]) =>
      prepareAndSendMock(...args),
  })
)

vi.mock('../src/shared/gqlClientFactory', () => ({
  createGQLClient: vi.fn().mockResolvedValue({}),
}))

const advanceCursorMock = vi.fn()
vi.mock('../src/cursor/rawProcessor', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/cursor/rawProcessor')>()
  return {
    ...actual,
    advanceCursor: (...args: unknown[]) => advanceCursorMock(...args),
  }
})

function makeRecord(
  sessionId: string,
  recordId: string,
  createdAt?: string
): CursorRawRecord {
  return {
    bubble: {
      createdAt,
      toolFormerData: {},
      codeBlocks: [],
    },
    metadata: { recordId, sessionId, model: 'gpt-4' },
  }
}

describe('uploadCursorRawRecords', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prepareAndSendMock.mockResolvedValue({ ok: true, errors: null })
  })

  it('returns { uploaded: 0 } for empty input', async () => {
    const result = await uploadCursorRawRecords([])
    expect(result).toEqual({ uploaded: 0 })
    expect(prepareAndSendMock).not.toHaveBeenCalled()
  })

  it('uploads records and advances cursors per session', async () => {
    const records = [
      makeRecord('session-1', 'r1', '2024-01-01T00:00:01Z'),
      makeRecord('session-1', 'r2', '2024-01-01T00:00:02Z'),
      makeRecord('session-2', 'r3', '2024-01-01T00:00:03Z'),
    ]

    const result = await uploadCursorRawRecords(records)

    expect(result).toEqual({ uploaded: 3 })
    expect(prepareAndSendMock).toHaveBeenCalledTimes(1)

    const tracyRecords = prepareAndSendMock.mock.calls[0]![1]
    expect(tracyRecords).toHaveLength(3)
    expect(tracyRecords[0].recordId).toBe('r1')
    expect(tracyRecords[0].platform).toBe('CURSOR')
    expect(tracyRecords[0].repositoryUrl).toBe(
      'https://github.com/test-org/test-repo'
    )

    // Cursor should be advanced to last record per session
    expect(advanceCursorMock).toHaveBeenCalledTimes(2)
    expect(advanceCursorMock).toHaveBeenCalledWith('session-1', {
      recordId: 'r2',
      timestamp: '2024-01-01T00:00:02Z',
      lastRowId: undefined,
      pending: false,
      incompleteBubbles: undefined,
    })
    expect(advanceCursorMock).toHaveBeenCalledWith('session-2', {
      recordId: 'r3',
      timestamp: '2024-01-01T00:00:03Z',
      lastRowId: undefined,
      pending: false,
      incompleteBubbles: undefined,
    })
  })

  it('does not advance cursors when upload fails', async () => {
    prepareAndSendMock.mockResolvedValueOnce({
      ok: false,
      errors: ['server error'],
    })

    const records = [makeRecord('session-1', 'r1', '2024-01-01T00:00:01Z')]

    await expect(uploadCursorRawRecords(records)).rejects.toThrow(
      'Tracy batch upload had errors'
    )
    expect(advanceCursorMock).not.toHaveBeenCalled()
  })

  it('passes sanitize: true when config.sanitizeData is true', async () => {
    getConfigMock.mockReturnValueOnce({
      apiUrl: 'https://api.mobb.ai/v1/graphql',
      webAppUrl: 'https://app.mobb.ai',
      extensionVersion: '0.1.0',
      sanitizeData: true,
    })

    const records = [makeRecord('session-1', 'r1', '2024-01-01T00:00:01Z')]
    await uploadCursorRawRecords(records)

    // 4th argument to prepareAndSendTracyRecords is options
    const options = prepareAndSendMock.mock.calls[0]![3]
    expect(options).toEqual({ sanitize: true })
  })

  it('passes sanitize: false when config.sanitizeData is false', async () => {
    const records = [makeRecord('session-1', 'r1', '2024-01-01T00:00:01Z')]
    await uploadCursorRawRecords(records)

    const options = prepareAndSendMock.mock.calls[0]![3]
    expect(options).toEqual({ sanitize: false })
  })

  it('deduplicates repo lookups via cache', async () => {
    const { getNormalizedRepo } = await import('../src/shared/repositoryInfo')

    const records = [
      makeRecord('session-1', 'r1', '2024-01-01T00:00:01Z'),
      makeRecord('session-1', 'r2', '2024-01-01T00:00:02Z'),
    ]

    await uploadCursorRawRecords(records)

    // Both records have no file path (empty codeBlocks), so the repo lookup
    // (which now returns both gitRepoUrl and gitRoot in a single call)
    // should be resolved once for the shared undefined key.
    expect(getNormalizedRepo).toHaveBeenCalledTimes(1)
  })
})
