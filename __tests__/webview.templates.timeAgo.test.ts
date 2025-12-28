import { describe, expect, it, vi } from 'vitest'

import {
  conversationMessage,
  timeAgo,
} from '../src/webview/templates/components'

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
