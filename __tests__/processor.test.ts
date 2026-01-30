import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as db from '../src/cursor/db'
import {
  markExistingToolCallsAsUploaded,
  processBubbles,
  resetProcessedBubbles,
} from '../src/cursor/processor'

vi.mock('vscode', () => {
  return {}
})

vi.mock('../src/cursor/db', () => {
  return {
    getRowsByLike: vi.fn(),
    getCompletedFileEditBubbles: vi.fn(),
    getComposerContent: vi.fn(),
  }
})

vi.mock('../src/shared/logger', () => {
  return {
    logger: {
      info: vi.fn(),
      error: vi.fn(),
    },
  }
})

const getRowsByLike = vi.mocked(db.getRowsByLike)
const getComposerContent = vi.mocked(db.getComposerContent)

beforeEach(() => {
  resetProcessedBubbles()
  getRowsByLike.mockReset()
  getComposerContent.mockReset()
})

// Helper to create a bubble row with value
function createBubbleRow(
  key: string,
  codeblockId: string | null,
  createdAt: string,
  status = 'completed',
  userDecision = 'accepted',
  toolCallId = `tool-call-${Math.random().toString(36).slice(2)}`
) {
  return {
    key,
    value: JSON.stringify({
      createdAt,
      toolFormerData: codeblockId
        ? {
            status,
            userDecision,
            toolCallId,
            additionalData: {
              codeblockId,
            },
            result: JSON.stringify({
              diff: {
                chunks: [
                  {
                    diffString: '- old\n+ new line',
                  },
                ],
              },
            }),
          }
        : {
            status,
            toolCallId: codeblockId === null ? undefined : toolCallId,
          },
    }),
  }
}

// Helper to create composer data row
function createComposerRow(key: string, modelName = 'Test model') {
  return {
    key,
    value: JSON.stringify({
      fullConversationHeadersOnly: [],
      modelConfig: {
        modelName,
        maxModel: false,
      },
    }),
  }
}

// Helper to create an edit_file_v2 bubble row (no codeblockId, has content IDs)
function createEditFileV2BubbleRow(
  key: string,
  beforeContentId: string,
  afterContentId: string,
  createdAt: string,
  status = 'completed',
  toolCallId = `toolu_${Math.random().toString(36).slice(2)}`
) {
  return {
    key,
    value: JSON.stringify({
      createdAt,
      toolFormerData: {
        name: 'edit_file_v2',
        status,
        toolCallId,
        params: JSON.stringify({
          relativeWorkspacePath: '/path/to/file.ts',
          streamingContent: 'full file content...',
          noCodeblock: true,
        }),
        result: JSON.stringify({
          beforeContentId,
          afterContentId,
        }),
        additionalData: {}, // No codeblockId for edit_file_v2
      },
    }),
  }
}

describe('processor tests', () => {
  describe('codeblockId tracking', () => {
    it('processes bubble with valid codeblockId', async () => {
      const bubbleRow = createBubbleRow(
        'bubbleId:xxx:yyy',
        'codeblock-123',
        '3001-01-01T12:00:00.000Z'
      )

      getRowsByLike.mockResolvedValueOnce([createComposerRow('composerData:1')])

      const changes = await processBubbles([bubbleRow], new Date('2024-01-01'))

      expect(changes).toHaveLength(1)
      expect(changes[0].model).toBe('Test model')
      expect(changes[0].additions).toBe('new line')
    })

    it('skips bubble without codeblockId', async () => {
      const bubbleRow = createBubbleRow(
        'bubbleId:xxx:yyy',
        null, // no codeblockId
        '3001-01-01T12:00:00.000Z'
      )

      const changes = await processBubbles([bubbleRow], new Date('2024-01-01'))

      expect(changes).toHaveLength(0)
      expect(getRowsByLike).not.toHaveBeenCalled()
    })

    it('skips same codeblockId on second process (deduplication)', async () => {
      const bubbleRow = createBubbleRow(
        'bubbleId:xxx:yyy',
        'codeblock-123',
        '3001-01-01T12:00:00.000Z'
      )

      getRowsByLike.mockResolvedValue([createComposerRow('composerData:1')])

      // First call - should process
      const changes1 = await processBubbles([bubbleRow], new Date('2024-01-01'))
      expect(changes1).toHaveLength(1)

      // Second call with same codeblockId - should skip
      const changes2 = await processBubbles([bubbleRow], new Date('2024-01-01'))
      expect(changes2).toHaveLength(0)
    })

    it('processes different codeblockIds from different bubbles', async () => {
      const bubble1 = createBubbleRow(
        'bubbleId:aaa:111',
        'codeblock-1',
        '3001-01-01T12:00:00.000Z'
      )
      const bubble2 = createBubbleRow(
        'bubbleId:bbb:222',
        'codeblock-2',
        '3001-01-01T12:01:00.000Z'
      )

      getRowsByLike.mockResolvedValue([createComposerRow('composerData:1')])

      const changes = await processBubbles(
        [bubble1, bubble2],
        new Date('2024-01-01')
      )

      expect(changes).toHaveLength(2)
    })
  })

  describe('markExistingToolCallsAsUploaded', () => {
    it('marks codeblockIds from completed bubbles as seen', async () => {
      const bubbleRow = createBubbleRow(
        'bubbleId:xxx:yyy',
        'codeblock-123',
        '2024-01-01T12:00:00.000Z',
        'completed'
      )

      markExistingToolCallsAsUploaded([bubbleRow])

      // Now processBubbles should skip this codeblockId
      const changes = await processBubbles([bubbleRow], new Date('2024-01-01'))
      expect(changes).toHaveLength(0)
    })

    it('does not mark incomplete bubbles as seen', async () => {
      const incompleteBubble = createBubbleRow(
        'bubbleId:xxx:yyy',
        'codeblock-123',
        '3001-01-01T12:00:00.000Z',
        'running' // not completed
      )

      markExistingToolCallsAsUploaded([incompleteBubble])

      // Create a completed version of the same bubble
      const completedBubble = createBubbleRow(
        'bubbleId:xxx:yyy',
        'codeblock-123',
        '3001-01-01T12:00:00.000Z',
        'completed'
      )

      getRowsByLike.mockResolvedValue([createComposerRow('composerData:1')])

      // Should still process because it wasn't marked as seen (was incomplete)
      const changes = await processBubbles(
        [completedBubble],
        new Date('2024-01-01')
      )
      expect(changes).toHaveLength(1)
    })

    it('ignores bubbles without codeblockId', async () => {
      const bubbleWithoutCodeblock = createBubbleRow(
        'bubbleId:xxx:yyy',
        null,
        '2024-01-01T12:00:00.000Z'
      )

      // Should not throw
      markExistingToolCallsAsUploaded([bubbleWithoutCodeblock])

      // A new bubble with codeblockId should still be processed
      const newBubble = createBubbleRow(
        'bubbleId:aaa:bbb',
        'codeblock-new',
        '3001-01-01T12:00:00.000Z'
      )

      getRowsByLike.mockResolvedValue([createComposerRow('composerData:1')])

      const changes = await processBubbles([newBubble], new Date('2024-01-01'))
      expect(changes).toHaveLength(1)
    })
  })

  describe('timestamp filtering', () => {
    it('skips bubbles created before startupTimestamp and marks as seen', async () => {
      const oldBubble = createBubbleRow(
        'bubbleId:xxx:yyy',
        'codeblock-old',
        '2024-01-01T12:00:00.000Z' // before startup
      )

      const startupTimestamp = new Date('2024-06-01T00:00:00.000Z')

      // First call - should skip but mark as seen
      const changes1 = await processBubbles([oldBubble], startupTimestamp)
      expect(changes1).toHaveLength(0)

      // Second call - should still skip (already marked as seen)
      // This verifies the optimization: we don't re-check old bubbles
      const changes2 = await processBubbles([oldBubble], startupTimestamp)
      expect(changes2).toHaveLength(0)

      // getRowsByLike should never have been called (we skip before querying)
      expect(getRowsByLike).not.toHaveBeenCalled()
    })

    it('processes bubbles created after startupTimestamp', async () => {
      const newBubble = createBubbleRow(
        'bubbleId:xxx:yyy',
        'codeblock-new',
        '2024-06-15T12:00:00.000Z' // after startup
      )

      const startupTimestamp = new Date('2024-06-01T00:00:00.000Z')

      getRowsByLike.mockResolvedValue([createComposerRow('composerData:1')])

      const changes = await processBubbles([newBubble], startupTimestamp)
      expect(changes).toHaveLength(1)
    })
  })

  describe('status filtering', () => {
    it('skips bubbles with status !== completed', async () => {
      const runningBubble = createBubbleRow(
        'bubbleId:xxx:yyy',
        'codeblock-123',
        '3001-01-01T12:00:00.000Z',
        'running'
      )

      getRowsByLike.mockResolvedValue([createComposerRow('composerData:1')])

      const changes = await processBubbles(
        [runningBubble],
        new Date('2024-01-01')
      )
      expect(changes).toHaveLength(0)
    })
  })

  describe('conversation extraction', () => {
    it('filters out conversation events after bubbleTimestamp', async () => {
      const bubbleTimestamp = new Date('2024-01-15T10:00:00Z')

      const mainBubble = {
        key: 'bubbleId:main',
        value: JSON.stringify({
          createdAt: bubbleTimestamp.toISOString(),
          toolFormerData: {
            status: 'completed',
            userDecision: 'accepted',
            toolCallId: 'tool-call-conv-1',
            additionalData: {
              codeblockId: 'codeblockId1',
            },
            result: JSON.stringify({
              diff: {
                chunks: [{ diffString: '+ addition1' }],
              },
            }),
          },
        }),
      }

      getRowsByLike
        // Composer data with conversation bubbles
        .mockResolvedValueOnce([
          {
            key: 'composerData:1',
            value: JSON.stringify({
              fullConversationHeadersOnly: [
                { bubbleId: 'bubble-before' },
                { bubbleId: 'bubble-at' },
                { bubbleId: 'bubble-after' },
              ],
              modelConfig: { modelName: 'Test model', maxModel: false },
            }),
          },
        ])
        // Conversation bubble before timestamp
        .mockResolvedValueOnce([
          {
            key: 'bubble-before',
            value: JSON.stringify({
              createdAt: '2024-01-15T09:30:00Z',
              text: 'Before timestamp',
            }),
          },
        ])
        // Conversation bubble at timestamp
        .mockResolvedValueOnce([
          {
            key: 'bubble-at',
            value: JSON.stringify({
              createdAt: bubbleTimestamp.toISOString(),
              text: 'At timestamp',
            }),
          },
        ])
        // Conversation bubble after timestamp (should be filtered)
        .mockResolvedValueOnce([
          {
            key: 'bubble-after',
            value: JSON.stringify({
              createdAt: '2024-01-15T10:30:00Z',
              text: 'After timestamp',
            }),
          },
        ])

      const changes = await processBubbles([mainBubble], new Date('2024-01-01'))

      expect(changes).toHaveLength(1)
      expect(changes[0].conversation).toHaveLength(2)
      expect(changes[0].conversation[0].text).toBe('Before timestamp')
      expect(changes[0].conversation[1].text).toBe('At timestamp')
    })
  })

  describe('additions extraction', () => {
    it('extracts multiple addition lines from diff', async () => {
      const bubble = {
        key: 'bubbleId:xxx:yyy',
        value: JSON.stringify({
          createdAt: '3001-01-01T12:00:00.000Z',
          toolFormerData: {
            status: 'completed',
            userDecision: 'accepted',
            toolCallId: 'tool-call-add-1',
            additionalData: {
              codeblockId: 'codeblock-123',
            },
            result: JSON.stringify({
              diff: {
                chunks: [
                  {
                    diffString:
                      '- removed line\n+ addition1\n+ addition2\n+ addition3',
                  },
                ],
              },
            }),
          },
        }),
      }

      getRowsByLike.mockResolvedValue([createComposerRow('composerData:1')])

      const changes = await processBubbles([bubble], new Date('2024-01-01'))

      expect(changes).toHaveLength(1)
      expect(changes[0].additions).toBe('addition1\naddition2\naddition3')
    })

    it('extracts additions from multiple chunks', async () => {
      const bubble = {
        key: 'bubbleId:xxx:yyy',
        value: JSON.stringify({
          createdAt: '3001-01-01T12:00:00.000Z',
          toolFormerData: {
            status: 'completed',
            userDecision: 'accepted',
            toolCallId: 'tool-call-add-2',
            additionalData: {
              codeblockId: 'codeblock-123',
            },
            result: JSON.stringify({
              diff: {
                chunks: [
                  { diffString: '+ chunk1line1\n+ chunk1line2' },
                  { diffString: '- removed\n+ chunk2line1' },
                ],
              },
            }),
          },
        }),
      }

      getRowsByLike.mockResolvedValue([createComposerRow('composerData:1')])

      const changes = await processBubbles([bubble], new Date('2024-01-01'))

      expect(changes).toHaveLength(1)
      expect(changes[0].additions).toBe('chunk1line1\nchunk1line2\nchunk2line1')
    })
  })

  describe('edge cases', () => {
    it('handles bubbles with no value', async () => {
      const bubbleWithoutValue = { key: 'bubbleId:xxx:yyy' }

      const changes = await processBubbles(
        [bubbleWithoutValue],
        new Date('2024-01-01')
      )
      expect(changes).toHaveLength(0)
    })

    it('handles malformed JSON gracefully', async () => {
      const malformedBubble = {
        key: 'bubbleId:xxx:yyy',
        value: 'not valid json',
      }

      const changes = await processBubbles(
        [malformedBubble],
        new Date('2024-01-01')
      )
      expect(changes).toHaveLength(0)
    })

    it('skips bubble when composerData not found', async () => {
      const bubble = createBubbleRow(
        'bubbleId:xxx:yyy',
        'codeblock-123',
        '3001-01-01T12:00:00.000Z'
      )

      getRowsByLike.mockResolvedValue([]) // No composer data

      const changes = await processBubbles([bubble], new Date('2024-01-01'))
      expect(changes).toHaveLength(0)
    })

    it('skips bubble when model not found in composerData', async () => {
      const bubble = createBubbleRow(
        'bubbleId:xxx:yyy',
        'codeblock-123',
        '3001-01-01T12:00:00.000Z'
      )

      getRowsByLike.mockResolvedValue([
        {
          key: 'composerData:1',
          value: JSON.stringify({
            fullConversationHeadersOnly: [],
            // No modelConfig
          }),
        },
      ])

      const changes = await processBubbles([bubble], new Date('2024-01-01'))
      expect(changes).toHaveLength(0)
    })
  })

  describe('edit_file_v2 handling', () => {
    it('processes edit_file_v2 bubble with content IDs', async () => {
      const bubble = createEditFileV2BubbleRow(
        'bubbleId:xxx:yyy',
        'composer.content.before123',
        'composer.content.after456',
        '3001-01-01T12:00:00.000Z'
      )

      // Mock content lookup
      getComposerContent
        .mockResolvedValueOnce('line1\nline2\n') // before content
        .mockResolvedValueOnce('line1\nline2\nline3 added\n') // after content

      // Mock composer lookup
      getRowsByLike.mockResolvedValueOnce([createComposerRow('composerData:1')])

      const changes = await processBubbles([bubble], new Date('2024-01-01'))

      expect(changes).toHaveLength(1)
      expect(changes[0].additions).toBe('line3 added')
      expect(changes[0].model).toBe('Test model')
      expect(getComposerContent).toHaveBeenCalledWith(
        'composer.content.before123'
      )
      expect(getComposerContent).toHaveBeenCalledWith(
        'composer.content.after456'
      )
    })

    it('extracts multiple added lines from edit_file_v2', async () => {
      const bubble = createEditFileV2BubbleRow(
        'bubbleId:xxx:yyy',
        'composer.content.before',
        'composer.content.after',
        '3001-01-01T12:00:00.000Z'
      )

      // Mock content lookup - before has 1 line, after has 4 lines
      getComposerContent
        .mockResolvedValueOnce('original line\n')
        .mockResolvedValueOnce(
          'original line\nnew line 1\nnew line 2\nnew line 3\n'
        )

      getRowsByLike.mockResolvedValueOnce([createComposerRow('composerData:1')])

      const changes = await processBubbles([bubble], new Date('2024-01-01'))

      expect(changes).toHaveLength(1)
      expect(changes[0].additions).toBe('new line 1\nnew line 2\nnew line 3')
    })

    it('handles edit_file_v2 with complete file replacement', async () => {
      const bubble = createEditFileV2BubbleRow(
        'bubbleId:xxx:yyy',
        'composer.content.before',
        'composer.content.after',
        '3001-01-01T12:00:00.000Z'
      )

      // Mock content lookup - completely different content
      getComposerContent
        .mockResolvedValueOnce('old content\nold line 2\n')
        .mockResolvedValueOnce('new content\nnew line 2\nnew line 3\n')

      getRowsByLike.mockResolvedValueOnce([createComposerRow('composerData:1')])

      const changes = await processBubbles([bubble], new Date('2024-01-01'))

      expect(changes).toHaveLength(1)
      // Should contain only additions (new content)
      expect(changes[0].additions).toContain('new content')
      expect(changes[0].additions).toContain('new line 2')
      expect(changes[0].additions).toContain('new line 3')
    })

    it('skips edit_file_v2 when before content not found', async () => {
      const bubble = createEditFileV2BubbleRow(
        'bubbleId:xxx:yyy',
        'composer.content.before',
        'composer.content.after',
        '3001-01-01T12:00:00.000Z'
      )

      // Mock content lookup - before content not found
      getComposerContent
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce('after content')

      const changes = await processBubbles([bubble], new Date('2024-01-01'))

      expect(changes).toHaveLength(0)
    })

    it('skips edit_file_v2 when after content not found', async () => {
      const bubble = createEditFileV2BubbleRow(
        'bubbleId:xxx:yyy',
        'composer.content.before',
        'composer.content.after',
        '3001-01-01T12:00:00.000Z'
      )

      // Mock content lookup - after content not found
      getComposerContent
        .mockResolvedValueOnce('before content')
        .mockResolvedValueOnce(undefined)

      const changes = await processBubbles([bubble], new Date('2024-01-01'))

      expect(changes).toHaveLength(0)
    })

    it('skips edit_file_v2 when composer not found', async () => {
      const bubble = createEditFileV2BubbleRow(
        'bubbleId:xxx:yyy',
        'composer.content.before',
        'composer.content.after',
        '3001-01-01T12:00:00.000Z'
      )

      // Mock content lookup
      getComposerContent
        .mockResolvedValueOnce('before content')
        .mockResolvedValueOnce('after content')

      // Mock composer lookup - not found
      getRowsByLike.mockResolvedValueOnce([])

      const changes = await processBubbles([bubble], new Date('2024-01-01'))

      expect(changes).toHaveLength(0)
    })

    it('deduplicates edit_file_v2 by toolCallId', async () => {
      const toolCallId = 'toolu_unique123'
      const bubble = createEditFileV2BubbleRow(
        'bubbleId:xxx:yyy',
        'composer.content.before',
        'composer.content.after',
        '3001-01-01T12:00:00.000Z',
        'completed',
        toolCallId
      )

      // Mock content lookup
      getComposerContent
        .mockResolvedValue('before content')
        .mockResolvedValue('after content with additions')

      getRowsByLike.mockResolvedValue([createComposerRow('composerData:1')])

      // Reset mocks for each call to have fresh content
      getComposerContent.mockReset()
      getComposerContent
        .mockResolvedValueOnce('before')
        .mockResolvedValueOnce('after new line')

      // First call - should process
      const changes1 = await processBubbles([bubble], new Date('2024-01-01'))
      expect(changes1).toHaveLength(1)

      // Second call with same toolCallId - should skip
      const changes2 = await processBubbles([bubble], new Date('2024-01-01'))
      expect(changes2).toHaveLength(0)
    })

    it('handles edit_file_v2 with empty before content (new file)', async () => {
      const bubble = createEditFileV2BubbleRow(
        'bubbleId:xxx:yyy',
        'composer.content.before',
        'composer.content.after',
        '3001-01-01T12:00:00.000Z'
      )

      // Mock content lookup - empty before (new file)
      getComposerContent
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('line1\nline2\nline3\n')

      getRowsByLike.mockResolvedValueOnce([createComposerRow('composerData:1')])

      const changes = await processBubbles([bubble], new Date('2024-01-01'))

      expect(changes).toHaveLength(1)
      expect(changes[0].additions).toBe('line1\nline2\nline3')
    })

    it('processes edit_file_v2 with inline modifications', async () => {
      const bubble = createEditFileV2BubbleRow(
        'bubbleId:xxx:yyy',
        'composer.content.before',
        'composer.content.after',
        '3001-01-01T12:00:00.000Z'
      )

      // Mock content lookup - modification in middle of file
      getComposerContent
        .mockResolvedValueOnce('function hello() {\n  console.log("old");\n}\n')
        .mockResolvedValueOnce(
          'function hello() {\n  console.log("new message");\n  console.log("extra line");\n}\n'
        )

      getRowsByLike.mockResolvedValueOnce([createComposerRow('composerData:1')])

      const changes = await processBubbles([bubble], new Date('2024-01-01'))

      expect(changes).toHaveLength(1)
      // Should contain the new/modified lines
      expect(changes[0].additions).toContain('console.log("new message")')
      expect(changes[0].additions).toContain('console.log("extra line")')
    })
  })
})
