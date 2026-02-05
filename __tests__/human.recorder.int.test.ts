import { beforeEach, describe, expect, it, vi } from 'vitest'

import { HumanRecorder } from '../src/human/recorder'
import type { Segment } from '../src/human/segmenter'
import { SegmentClassification } from '../src/human/types'
import { uploadAiBlameHandlerFromExtension } from '../src/mobbdev_src/args/commands/upload_ai_blame'
import { AppType } from '../src/shared/repositoryInfo'

// Hoisted containers to satisfy Vitest mock hoisting
const h = vi.hoisted(() => {
  return {
    textDocs: [] as Array<{
      uri: { toString(): string }
      fileName: string
      lineAt: (ln: number) => { text: string }
    }>,
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
    },
  }
})

// Stub logger to avoid requiring initLogger/output channel in these tests.
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

vi.mock('../src/mobbdev_src/args/commands/upload_ai_blame', () => ({
  uploadAiBlameHandlerFromExtension: vi.fn().mockResolvedValue({
    promptsCounts: {
      detections: { total: 0, high: 0, medium: 0, low: 0 },
    },
    inferenceCounts: {
      detections: { total: 0, high: 0, medium: 0, low: 0 },
    },
    promptsUUID: 'test-prompts-uuid',
    inferenceUUID: 'test-inference-uuid',
  }),
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
    // Long line to exceed the default non-whitespace threshold (30 chars).
    const text = 'abcdefghijklmnopqrstuvwxyz1234567890\n'
    const recorder = new HumanRecorder({
      uploadEnabled: true,
      minSegmentCharsWithNoWhitespace: 30,
      appType: AppType.VSCODE,
    })
    const seg = makeSegment(text)
    await recorder.record(seg, SegmentClassification.HUMAN_POSITIVE)

    const uploaderMock = vi.mocked(uploadAiBlameHandlerFromExtension)
    await vi.waitFor(() => {
      expect(uploaderMock).toHaveBeenCalledTimes(1)
    })
    const args = uploaderMock.mock.calls[0]![0] as {
      model: string
      tool: string
      prompts: Array<{ type: string }>
      inference: string
    }
    expect(args.model).toBe('human')
    expect(args.tool).toBe('VSCode')
    expect(args.prompts?.[0]?.type).toBe('TOOL_EXECUTION')
    expect(args.inference).toContain('abcdefghijklmnopqrstuvwxyz1234567890')
  })

  it('logs artifacts but does not upload when uploadEnabled=false (dry-run)', () => {
    const text = 'const a = 1;\nconst b = 2;\n'
    const recorder = new HumanRecorder({
      uploadEnabled: false,
      minSegmentCharsWithNoWhitespace: 30,
      appType: AppType.VSCODE,
    })
    const seg = makeSegment(text)
    void recorder.record(seg, SegmentClassification.HUMAN_POSITIVE)

    const uploaderMock = vi.mocked(uploadAiBlameHandlerFromExtension)
    expect(uploaderMock).not.toHaveBeenCalled()
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

    const uploaderMock = vi.mocked(uploadAiBlameHandlerFromExtension)
    expect(uploaderMock).not.toHaveBeenCalled()
  })

  // Non-human classifications are filtered earlier in the pipeline (index.ts).
  // HumanRecorder assumes it is only called with HUMAN segment classifications.
})
