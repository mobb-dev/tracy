import { describe, expect, it, vi } from 'vitest'

import { SegmentClassification } from '../src/human/types'
import type { HumanSegmentUpload } from '../src/human/uploader'
import { uploadHumanChangesFromExtension } from '../src/human/uploader'

vi.mock('vscode', () => ({}))

vi.mock('../src/mobbdev_src/args/commands/upload_ai_blame', () => ({
  uploadAiBlameHandlerFromExtension: vi.fn().mockResolvedValue({
    promptsCounts: {
      pii: { total: 0, high: 0, medium: 0, low: 0 },
      secrets: 0,
    },
    inferenceCounts: {
      pii: { total: 0, high: 0, medium: 0, low: 0 },
      secrets: 0,
    },
    promptsUUID: 'test-prompts-uuid',
    inferenceUUID: 'test-inference-uuid',
  }),
}))

describe('Human uploader artifacts', () => {
  it('builds a TOOL_EXECUTION prompt and inference from a single segment', async () => {
    const segment: HumanSegmentUpload = {
      timestamp: new Date(0).toISOString(),
      uri: 'file:///ws/x.ts',
      fileName: '/ws/x.ts',
      relativePath: 'x.ts',
      startLine: 10,
      endLine: 12,
      changedLines: 'const a = 1\nconst b = 2\n',
      metrics: {
        durationMs: 500,
        totalInserted: 5,
      },
      segmentClassification: SegmentClassification.HUMAN_POSITIVE,
    }

    const { uploadAiBlameHandlerFromExtension } = await import(
      '../src/mobbdev_src/args/commands/upload_ai_blame'
    )

    await uploadHumanChangesFromExtension(segment)

    const uploaderMock = vi.mocked(uploadAiBlameHandlerFromExtension)
    expect(uploaderMock).toHaveBeenCalledTimes(1)
    const args = uploaderMock.mock.calls[0]![0] as {
      model: string
      tool: string
      prompts: Array<{
        type: string
        attachedFiles?: Array<{ relativePath: string; startLine: number }>
        tool?: { name?: string; parameters?: string }
      }>
      inference: string
    }

    expect(args.model).toBe('human')
    expect(args.tool).toBe('Cursor')
    expect(args.prompts.length).toBe(1)
    const prompt = args.prompts[0]!
    expect(prompt.type).toBe('TOOL_EXECUTION')
    expect(prompt.tool?.name).toBe('human_typing')
    expect(prompt.attachedFiles?.[0]?.relativePath).toBe('x.ts')
    expect(prompt.attachedFiles?.[0]?.startLine).toBe(10)
    expect(args.inference).toBe(segment.changedLines.trim())
  })
})
