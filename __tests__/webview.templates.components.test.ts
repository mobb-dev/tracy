import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  conversationMessage,
  conversationSection,
  timeAgo,
} from '../src/webview/templates/components'

// Mock vscode module
vi.mock('vscode', () => ({
  env: {
    appName: 'Visual Studio Code',
  },
}))

describe('webview templates - timeAgo', () => {
  it('returns empty string for invalid date strings', () => {
    expect(timeAgo('not a date')).toBe('')
  })

  it('does not render "NaN months ago" for invalid message dates', () => {
    const html = conversationMessage({
      type: 'USER_PROMPT',
      text: 'hello',
      date: 'not a date',
    })

    expect(html).not.toContain('NaN')
    expect(html).not.toContain('class="timestamp"')
  })

  it('still renders valid relative timestamps', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:01:00Z'))

    try {
      expect(timeAgo('2025-01-01T00:00:30Z')).toBe('just now')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('conversationSection - app type detection', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('shows continue button in VSCode', async () => {
    // Mock detectAppType to return VSCODE
    vi.doMock('../src/shared/repositoryInfo', () => ({
      AppType: {
        VSCODE: 'vscode',
        CURSOR: 'cursor',
        UNKNOWN: 'unknown',
      },
      detectAppType: vi.fn(() => 'vscode'),
    }))

    const { conversationSection } = await import(
      '../src/webview/templates/components'
    )

    const messages = [
      { type: 'USER_PROMPT', text: 'Hello', date: '2024-01-01' },
    ]

    const result = conversationSection(messages, 'SUCCESS')

    expect(result).toContain('<h3>AI Conversation</h3>')
    expect(result).toContain('Hello')
    expect(result).toContain('Continue Conversation')
  })

  it('hides continue button in Cursor', async () => {
    // Mock detectAppType to return CURSOR
    vi.doMock('../src/shared/repositoryInfo', () => ({
      AppType: {
        VSCODE: 'vscode',
        CURSOR: 'cursor',
        UNKNOWN: 'unknown',
      },
      detectAppType: vi.fn(() => 'cursor'),
    }))

    const { conversationSection } = await import(
      '../src/webview/templates/components'
    )

    const messages = [
      { type: 'USER_PROMPT', text: 'Hello', date: '2024-01-01' },
    ]

    const result = conversationSection(messages, 'SUCCESS')

    expect(result).toContain('<h3>AI Conversation</h3>')
    expect(result).toContain('Hello')
    expect(result).not.toContain('Continue Conversation')
  })

  it('shows loading state', () => {
    const result = conversationSection([], 'LOADING')

    expect(result).toContain('Loading conversation...')
    expect(result).toContain('spinner')
  })

  it('shows error state', () => {
    const result = conversationSection([], 'ERROR', 'Network failed')

    expect(result).toContain('<h3>AI Conversation</h3>')
    expect(result).toContain('Network failed')
    expect(result).toContain('conversation-error')
  })

  it('returns empty string for no messages', () => {
    const result = conversationSection([], 'SUCCESS')

    expect(result).toBe('')
  })
})
