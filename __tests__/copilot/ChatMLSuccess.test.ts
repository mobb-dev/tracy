import * as fs from 'node:fs'

import { describe, expect, it } from 'vitest'

import { ChatMLSuccess } from '../../src/copilot/events'

describe('ChatMLSuccess tests', () => {
  it('getPromptData', () => {
    const chat = new ChatMLSuccess(
      '',
      '',
      '',
      '',
      '',
      new Date(),
      new Date(),
      1000,
      undefined,
      [''],
      {
        messages: JSON.parse(
          fs.readFileSync(`${__dirname}/files/messages.json`, 'utf-8')
        ),
      },
      ''
    )
    const promptData = chat.getPromptData()

    expect(promptData).toHaveLength(9)

    expect(promptData[0].type).toBe('USER_PROMPT')
    expect(promptData[1].type).toBe('AI_RESPONSE')
    expect(promptData[2].type).toBe('AI_RESPONSE')
    expect(promptData[3].type).toBe('AI_RESPONSE')
    expect(promptData[4].type).toBe('AI_RESPONSE')
    expect(promptData[5].type).toBe('USER_PROMPT')
    expect(promptData[6].type).toBe('AI_RESPONSE')
    expect(promptData[7].type).toBe('USER_PROMPT')
    expect(promptData[8].type).toBe('USER_PROMPT')

    expect(promptData[1].text).toBe(
      "I'll help you remove repetitions from your code. Let me first check what's in the file. "
    )
    expect(promptData[5].text).toBe('now rename kirill to main')
  })
})
