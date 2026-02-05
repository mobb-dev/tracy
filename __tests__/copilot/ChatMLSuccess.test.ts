import * as fs from 'node:fs'

import { describe, expect, it } from 'vitest'

import { ChatMLSuccess } from '../../src/copilot/events'

describe('ChatMLSuccess tests', () => {
  it('getPromptData extracts user prompts, AI responses, and tool executions', () => {
    const chat = new ChatMLSuccess({
      id: '',
      type: '',
      name: '',
      requestType: '',
      model: '',
      requestId: 'test-request-id',
      startTime: new Date(),
      endTime: new Date(),
      durationMs: 1000,
      usage: undefined,
      toolNames: [''],
      requestMessages: {
        messages: JSON.parse(
          fs.readFileSync(`${__dirname}/files/messages.json`, 'utf-8')
        ),
      },
      raw: '',
    })
    const promptData = chat.getPromptData()

    // Enhanced extraction now includes tool executions from role 2 messages
    // 4 USER_PROMPTs + 5 AI_RESPONSEs + 10 TOOL_EXECUTIONs = 19
    expect(promptData).toHaveLength(19)

    // Verify the sequence of types
    const types = promptData.map((p) => p.type)

    // Count by type
    const userPrompts = types.filter((t) => t === 'USER_PROMPT')
    const aiResponses = types.filter((t) => t === 'AI_RESPONSE')
    const toolExecutions = types.filter((t) => t === 'TOOL_EXECUTION')

    expect(userPrompts).toHaveLength(4)
    expect(aiResponses).toHaveLength(5)
    expect(toolExecutions).toHaveLength(10)

    // First item should be USER_PROMPT with the initial request
    expect(promptData[0].type).toBe('USER_PROMPT')
    expect(promptData[0].text).toBe('remove reoetiutions')

    // Second item should be AI_RESPONSE
    expect(promptData[1].type).toBe('AI_RESPONSE')
    expect(promptData[1].text).toBe(
      "I'll help you remove repetitions from your code. Let me first check what's in the file. "
    )

    // Third item should be the first TOOL_EXECUTION (read_file)
    expect(promptData[2].type).toBe('TOOL_EXECUTION')
    expect(promptData[2].tool?.name).toBe('read_file')
    expect(promptData[2].tool?.result).toContain('const a = 1')

    // Find the "rename kirill to main" user prompt
    const renamePrompt = promptData.find(
      (p) => p.type === 'USER_PROMPT' && p.text === 'now rename kirill to main'
    )
    expect(renamePrompt).toBeDefined()

    // Verify tool executions have results from role 3 messages
    const toolExecs = promptData.filter((p) => p.type === 'TOOL_EXECUTION')
    const readFileTools = toolExecs.filter((p) => p.tool?.name === 'read_file')
    expect(readFileTools.length).toBeGreaterThan(0)
    // read_file results should contain the file content
    expect(readFileTools[0].tool?.result).toContain('javascript')
  })
})
