import { beforeEach, describe, expect, it, vi } from 'vitest'

import { HumanRecorder } from '../src/human/recorder'
import type { Segment } from '../src/human/segmenter'
import { SegmentClassification } from '../src/human/types'
import { AppType } from '../src/shared/repositoryInfo'

// Hoisted containers to satisfy Vitest mock hoisting
const h = vi.hoisted(() => {
  return {
    textDocs: [] as Array<{
      uri: { toString(): string }
      fileName: string
      lineAt: (ln: number) => { text: string }
    }>,
    uploadTracyRecordsMock: vi.fn().mockResolvedValue(undefined),
  }
})

vi.mock('vscode', () => {
  const { textDocs } = h as { textDocs: typeof h.textDocs }
  return {
    window: {
      activeTextEditor: {
        document: {
          uri: { toString: () => 'file:///ws/file.ts' },
          fileName: '/ws/file.ts',
        },
      },
    },
    workspace: {
      textDocuments: textDocs,
      asRelativePath: (_uri: unknown) => 'file.ts',
      workspaceFolders: [],
    },
  }
})

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

vi.mock('../src/shared/logger', () => ({
  initLogger: vi.fn(),
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('../src/shared/config', () => ({
  getConfig: vi.fn().mockReturnValue({
    apiUrl: 'https://api.mobb.ai/v1/graphql',
    webAppUrl: 'https://app.mobb.ai',
    extensionVersion: '0.1.0',
  }),
}))

vi.mock('../src/human/config', async () => {
  const cfg = await vi.importActual<typeof import('../src/human/config')>(
    '../src/human/config'
  )

  return {
    HUMAN_TRACKING_CONFIG: {
      ...cfg.HUMAN_TRACKING_CONFIG,
      uploadEnabled: false,
    },
  }
})

// Mock uploadTracyRecords used by the human uploader
vi.mock('../src/shared/uploader', () => ({
  uploadTracyRecords: (...args: unknown[]) => h.uploadTracyRecordsMock(...args),
}))

function makeSegment(textContent: string): Segment {
  const now = Date.now()
  return {
    closed: true,
    documentUri: 'file:///ws/file.ts',
    fileName: '/ws/file.ts',
    rangeStartLine: 0,
    rangeEndLineExclusive: 2,
    textContent,
    startedAt: now - 600,
    endedAt: now,
  }
}

beforeEach(() => {
  const { textDocs } = h as { textDocs: typeof h.textDocs }
  textDocs.length = 0
  vi.clearAllMocks()
})

describe('HumanRecorder integration (current implementation)', () => {
  it('uploads immediately when uploadEnabled=true and above non-whitespace threshold', async () => {
    const text = 'abcdefghijklmnopqrstuvwxyz1234567890\n'
    const recorder = new HumanRecorder({
      uploadEnabled: true,
      minSegmentCharsWithNoWhitespace: 28,
      appType: AppType.VSCODE,
    })
    const seg = makeSegment(text)
    await recorder.record(seg, SegmentClassification.HUMAN_POSITIVE)

    await vi.waitFor(() => {
      expect(h.uploadTracyRecordsMock).toHaveBeenCalledTimes(1)
    })
    const records = h.uploadTracyRecordsMock.mock.calls[0]![0]
    expect(records).toHaveLength(1)
    const record = records[0]
    expect(record.platform).toBe('CLAUDE_CODE') // VSCode maps to CLAUDE_CODE
    expect(record.editType).toBe('HUMAN_EDIT')
    expect(record.additions).toContain('abcdefghijklmnopqrstuvwxyz1234567890')
  })

  it('logs artifacts but does not upload when uploadEnabled=false (dry-run)', () => {
    const text = 'const a = 1;\nconst b = 2;\n'
    const recorder = new HumanRecorder({
      uploadEnabled: false,
      minSegmentCharsWithNoWhitespace: 28,
      appType: AppType.VSCODE,
    })
    const seg = makeSegment(text)
    void recorder.record(seg, SegmentClassification.HUMAN_POSITIVE)

    expect(h.uploadTracyRecordsMock).not.toHaveBeenCalled()
  })

  it('does not upload when below minSegmentCharsWithNoWhitespace', () => {
    const text = 'abc\n' // 3 non-whitespace chars
    const recorder = new HumanRecorder({
      uploadEnabled: true,
      minSegmentCharsWithNoWhitespace: 10,
      appType: AppType.VSCODE,
    })
    const seg = makeSegment(text)
    void recorder.record(seg, SegmentClassification.HUMAN_POSITIVE)

    expect(h.uploadTracyRecordsMock).not.toHaveBeenCalled()
  })
})
