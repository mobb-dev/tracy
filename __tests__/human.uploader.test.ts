import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SegmentClassification } from '../src/human/types'
import type { HumanSegmentUpload } from '../src/human/uploader'
import { uploadHumanChangesFromExtension } from '../src/human/uploader'

vi.mock('vscode', () => ({
  workspace: { workspaceFolders: [] },
}))

vi.mock('../src/shared/repositoryInfo', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/shared/repositoryInfo')>()
  return {
    ...actual,
    getNormalizedRepoUrl: vi
      .fn()
      .mockResolvedValue('https://github.com/test-org/test-repo'),
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

const sanitizeDataMock = vi.fn((input: unknown) =>
  Promise.resolve(`[SANITIZED]${input}`)
)
vi.mock('../src/mobbdev_src/utils/sanitize-sensitive-data', () => ({
  sanitizeData: (...args: unknown[]) => sanitizeDataMock(...args),
}))

// Mock the uploadTracyRecords function used by the human uploader
const uploadTracyRecordsMock = vi.fn().mockResolvedValue(undefined)
vi.mock('../src/shared/uploader', () => ({
  uploadTracyRecords: (...args: unknown[]) => uploadTracyRecordsMock(...args),
}))

function makeSegment(
  overrides?: Partial<HumanSegmentUpload>
): HumanSegmentUpload {
  return {
    timestamp: new Date(0).toISOString(),
    uri: 'file:///ws/x.ts',
    fileName: '/ws/x.ts',
    relativePath: 'x.ts',
    startLine: 10,
    endLine: 12,
    changedLines: 'const a = 1\nconst b = 2\n',
    metrics: { durationMs: 500, totalInserted: 5 },
    segmentClassification: SegmentClassification.HUMAN_POSITIVE,
    ...overrides,
  }
}

describe('Human uploader artifacts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getConfigMock.mockReturnValue({
      apiUrl: 'https://api.mobb.ai/v1/graphql',
      webAppUrl: 'https://app.mobb.ai',
      extensionVersion: '0.1.0',
      sanitizeData: false,
    })
  })

  it('uploads a HUMAN_EDIT tracy record from a single segment', async () => {
    const segment = makeSegment()

    await uploadHumanChangesFromExtension(segment)

    expect(uploadTracyRecordsMock).toHaveBeenCalledTimes(1)
    const records = uploadTracyRecordsMock.mock.calls[0]![0]
    expect(records).toHaveLength(1)

    const record = records[0]
    expect(record.platform).toBe('CURSOR')
    expect(record.editType).toBe('HUMAN_EDIT')
    expect(record.additions).toBe('const a = 1\nconst b = 2')
    expect(record.filePath).toBe('x.ts')
    expect(record.clientVersion).toBe('0.1.0')
    expect(record.recordId).toBeDefined()
    expect(record.recordTimestamp).toBe(segment.timestamp)
  })

  it('sanitizes additions when config.sanitizeData is true', async () => {
    getConfigMock.mockReturnValue({
      apiUrl: 'https://api.mobb.ai/v1/graphql',
      webAppUrl: 'https://app.mobb.ai',
      extensionVersion: '0.1.0',
      sanitizeData: true,
    })

    await uploadHumanChangesFromExtension(makeSegment())

    expect(sanitizeDataMock).toHaveBeenCalledTimes(1)
    expect(sanitizeDataMock).toHaveBeenCalledWith('const a = 1\nconst b = 2')

    const record = uploadTracyRecordsMock.mock.calls[0]![0][0]
    expect(record.additions).toContain('[SANITIZED]')
  })

  it('does not sanitize additions when config.sanitizeData is false', async () => {
    await uploadHumanChangesFromExtension(makeSegment())

    expect(sanitizeDataMock).not.toHaveBeenCalled()

    const record = uploadTracyRecordsMock.mock.calls[0]![0][0]
    expect(record.additions).toBe('const a = 1\nconst b = 2')
  })
})
