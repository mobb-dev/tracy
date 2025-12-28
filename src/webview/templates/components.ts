import escapeHtml from 'escape-html'

import { html } from './html'

export function timeAgo(dateStr: string): string {
  if (!dateStr) {
    return ''
  }

  const date = new Date(dateStr)
  const dateMs = date.getTime()
  if (Number.isNaN(dateMs)) {
    return ''
  }

  const seconds = Math.floor((Date.now() - dateMs) / 1000)
  if (seconds < 60) {
    return 'just now'
  }
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60)
    return mins + (mins === 1 ? ' minute ago' : ' minutes ago')
  }
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600)
    return hours + (hours === 1 ? ' hour ago' : ' hours ago')
  }
  if (seconds < 604800) {
    const days = Math.floor(seconds / 86400)
    return days + (days === 1 ? ' day ago' : ' days ago')
  }
  if (seconds < 2592000) {
    const weeks = Math.floor(seconds / 604800)
    return weeks + (weeks === 1 ? ' week ago' : ' weeks ago')
  }
  const months = Math.floor(seconds / 2592000)
  return months + (months === 1 ? ' month ago' : ' months ago')
}

export const fileHeader = (
  fileName: string,
  lineNumber: number
): string => html`
  <h2>Tracey AI Information</h2>
  <div class="file-info">
    <strong>${escapeHtml(fileName)}</strong> &bull; Line ${lineNumber}
  </div>
  <hr />
`

export const metaInfo = (
  model: string,
  toolName: string,
  commitSha: string,
  commitUrl?: string
): string => {
  const safeModel = escapeHtml(model || 'Unknown')
  const safeToolName = escapeHtml(toolName || 'Unknown')
  const safeShortSha = escapeHtml(commitSha?.substring(0, 8) || 'Unknown')

  const commitDisplay = commitUrl
    ? html`<span
        class="meta-item meta-link"
        onclick="openCommit('${escapeHtml(commitUrl)}')"
        >${safeShortSha}</span
      >`
    : html`<span class="meta-item">${safeShortSha}</span>`

  return html`
    <div class="meta-info">
      <span class="meta-item">${safeModel}</span>
      <span class="meta-item">${safeToolName}</span>
      ${commitDisplay}
    </div>
  `
}

export const conversationMessage = (message: {
  type: string
  text: string
  date: string
}): string => {
  const isUser = message.type === 'USER_PROMPT'
  const messageClass = isUser ? 'user-message' : 'ai-message'
  const avatar = isUser ? '' : ''
  const timestamp = timeAgo(message.date)
  const escapedText = escapeHtml(message.text).replace(/\n/g, '<br>')

  return html`
    <div class="${messageClass}">
      <div class="message-header">
        <span class="avatar">${avatar}</span>
        ${timestamp ? html`<span class="timestamp">${timestamp}</span>` : ''}
      </div>
      <div class="message-content">${escapedText}</div>
    </div>
  `
}

export const conversationSection = (messages: unknown): string => {
  if (!Array.isArray(messages) || messages.length === 0) {
    return ''
  }

  const normalized = messages
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && !!m)
    .map((m) => ({
      type: typeof m.type === 'string' ? m.type : '',
      text: typeof m.text === 'string' ? m.text : '',
      date: typeof m.date === 'string' ? m.date : '',
    }))
    .filter((m) => m.text.length > 0)

  if (!normalized.length) {
    return ''
  }

  return html` <h3>AI Conversation</h3>
    <div class="conversation">
      ${normalized.map(conversationMessage).join('')}
    </div>`

  // TODO: restore this when we figure out how to make the button work
  //  <div class="action-buttons">
  //    <button onclick="continueConversation()">Continue Conversation</button>
  //  </div>
  //`
}

export const humanInfo = (): string => html`
  <div class="human-info">
    <span>Human-written code on this line</span>
  </div>
`
