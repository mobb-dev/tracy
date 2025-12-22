import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as db from '../src/cursor/db'
import {
  ignoreBubbles,
  processBubbles,
  resetProcessedBubbles,
} from '../src/cursor/processor'

vi.mock('vscode', () => {
  return {}
})

vi.mock('../src/cursor/db', () => {
  return {
    getRowsByLike: vi.fn(),
  }
})

vi.mock('../src/shared/logger', () => {
  return {
    logger: {
      info: vi.fn(),
    },
  }
})

const getRowsByLike = vi.mocked(db.getRowsByLike)

beforeEach(() => {
  resetProcessedBubbles()
  getRowsByLike.mockReset()
})

describe('processor tests', () => {
  it('returns changes for a valid bubble', async () => {
    getRowsByLike
      .mockResolvedValueOnce([
        {
          key: 'bubblekey1',
          value: JSON.stringify({
            createdAt: '3001-01-01T12:15:00.000Z',
            toolFormerData: {
              status: 'completed',
              userDecision: 'accepted',
              additionalData: {
                codeblockId: 'codeblockId1',
              },
              result: JSON.stringify({
                diff: {
                  chunks: [
                    {
                      diffString: '- hi\n+ addition1\n+ addition2',
                    },
                  ],
                },
              }),
            },
          }),
        },
      ])
      .mockResolvedValueOnce([
        {
          key: 'composerdatakey1',
          value: JSON.stringify({
            fullConversationHeadersOnly: [
              {
                bubbleId: 'bubblekey2',
              },
            ],
            modelConfig: {
              modelName: 'Test model',
              maxModel: false,
            },
          }),
        },
      ])
      .mockResolvedValueOnce([
        {
          key: 'bubblekey1',
          value: JSON.stringify({
            text: 'Test prompt',
            createdAt: '3001-01-01T12:00:00.000Z',
          }),
        },
      ])

    const changes = await processBubbles(
      [
        {
          key: 'bubblekey1',
        },
      ],
      new Date('2024-01-01')
    )

    expect(changes).toHaveLength(1)
    expect(changes[0].model).toBe('Test model')
    expect(changes[0].createdAt.getFullYear()).toBe(3001)
    expect(changes[0].additions).toBe('addition1\naddition2')
    expect(changes[0].conversation).toMatchInlineSnapshot(`
      [
        {
          "createdAt": "3001-01-01T12:00:00.000Z",
          "text": "Test prompt",
        },
      ]
    `)

    // Same bubble should be ignored
    expect(
      await processBubbles(
        [
          {
            key: 'bubblekey1',
          },
        ],
        new Date('2024-01-01')
      )
    ).toHaveLength(0)
  })

  it('ignored bubbles ignored', async () => {
    ignoreBubbles([
      {
        key: 'bubblekey1',
      },
    ])

    const changes = await processBubbles(
      [
        {
          key: 'bubblekey1',
        },
      ],
      new Date('2024-01-01')
    )

    expect(changes).toHaveLength(0)
  })

  it('filters out conversation events after bubbleTimestamp', async () => {
    const bubbleTimestamp = new Date('2024-01-15T10:00:00Z')

    // Mock data for the main bubble
    getRowsByLike
      .mockResolvedValueOnce([
        {
          key: 'bubblekey1',
          value: JSON.stringify({
            createdAt: bubbleTimestamp.toISOString(),
            toolFormerData: {
              status: 'completed',
              userDecision: 'accepted',
              additionalData: {
                codeblockId: 'codeblockId1',
              },
              result: JSON.stringify({
                diff: {
                  chunks: [
                    {
                      diffString: '+ addition1',
                    },
                  ],
                },
              }),
            },
          }),
        },
      ])
      // Mock data for composer with multiple conversation bubbles
      .mockResolvedValueOnce([
        {
          key: 'composerdatakey1',
          value: JSON.stringify({
            fullConversationHeadersOnly: [
              { bubbleId: 'bubble-before-1' },
              { bubbleId: 'bubble-before-2' },
              { bubbleId: 'bubble-at-timestamp' },
              { bubbleId: 'bubble-after-1' },
              { bubbleId: 'bubble-after-2' },
            ],
            modelConfig: {
              modelName: 'Test model',
              maxModel: false,
            },
          }),
        },
      ])
      // Mock conversation bubble 1 - before timestamp
      .mockResolvedValueOnce([
        {
          key: 'bubble-before-1',
          value: JSON.stringify({
            createdAt: '2024-01-15T09:30:00Z',
            text: 'User prompt 1 - before timestamp',
            type: 1,
          }),
        },
      ])
      // Mock conversation bubble 2 - before timestamp
      .mockResolvedValueOnce([
        {
          key: 'bubble-before-2',
          value: JSON.stringify({
            createdAt: '2024-01-15T09:45:00Z',
            text: 'Assistant response 1 - before timestamp',
            type: 2,
          }),
        },
      ])
      // Mock conversation bubble 3 - at timestamp
      .mockResolvedValueOnce([
        {
          key: 'bubble-at-timestamp',
          value: JSON.stringify({
            createdAt: bubbleTimestamp.toISOString(),
            text: 'User prompt 2 - at timestamp',
            type: 1,
          }),
        },
      ])
      // Mock conversation bubble 4 - after timestamp (should be filtered out)
      .mockResolvedValueOnce([
        {
          key: 'bubble-after-1',
          value: JSON.stringify({
            createdAt: '2024-01-15T10:15:00Z',
            text: 'User prompt 3 - after timestamp',
            type: 1,
          }),
        },
      ])
      // Mock conversation bubble 5 - after timestamp (should be filtered out)
      .mockResolvedValueOnce([
        {
          key: 'bubble-after-2',
          value: JSON.stringify({
            createdAt: '2024-01-15T10:30:00Z',
            text: 'Assistant response 2 - after timestamp',
            type: 2,
          }),
        },
      ])

    const changes = await processBubbles(
      [{ key: 'bubblekey1' }],
      new Date('2024-01-01') // startup timestamp
    )

    expect(changes).toHaveLength(1)

    // Verify only events before or at the bubbleTimestamp are included
    expect(changes[0].conversation).toHaveLength(3)

    // Verify the events are sorted by time
    expect(changes[0].conversation[0].text).toBe(
      'User prompt 1 - before timestamp'
    )
    expect(changes[0].conversation[1].text).toBe(
      'Assistant response 1 - before timestamp'
    )
    expect(changes[0].conversation[2].text).toBe('User prompt 2 - at timestamp')

    // Verify the timestamps are correct
    expect(new Date(changes[0].conversation[0].createdAt)).toEqual(
      new Date('2024-01-15T09:30:00Z')
    )
    expect(new Date(changes[0].conversation[1].createdAt)).toEqual(
      new Date('2024-01-15T09:45:00Z')
    )
    expect(new Date(changes[0].conversation[2].createdAt)).toEqual(
      new Date('2024-01-15T10:00:00Z')
    )
  })
})
