import escapeHtml from 'escape-html'

import { AppType, detectAppType } from '../../shared/repositoryInfo'
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
  <h2>Tracy AI Information</h2>
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
        class="meta-item meta-link commit-link"
        data-commit-url="${escapeHtml(commitUrl)}"
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
  const avatar = ''
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

export const conversationSection = (
  messages: unknown,
  conversationState: 'IDLE' | 'LOADING' | 'SUCCESS' | 'ERROR',
  conversationError?: string
): string => {
  // Show loading spinner
  if (conversationState === 'LOADING') {
    return html` <h3>AI Conversation</h3>
      <div class="conversation-loading">
        <div class="spinner"></div>
        <span>Loading conversation...</span>
      </div>`
  }

  // Show error message
  if (conversationState === 'ERROR') {
    const errorMessage = conversationError || 'Failed to load conversation'
    return html` <h3>AI Conversation</h3>
      <div class="conversation-error">
        <span>${escapeHtml(errorMessage)}</span>
      </div>`
  }

  // Show conversation if we have messages
  if (Array.isArray(messages) && messages.length > 0) {
    const normalized = messages
      .filter((m): m is Record<string, unknown> => typeof m === 'object' && !!m)
      .map((m) => ({
        type: typeof m.type === 'string' ? m.type : '',
        text: typeof m.text === 'string' ? m.text : '',
        date: typeof m.date === 'string' ? m.date : '',
      }))
      .filter((m) => m.text.length > 0)

    if (normalized.length > 0) {
      const conversationPart = html` <h3>AI Conversation</h3>
        <div class="conversation">
          ${normalized.map(conversationMessage).join('')}
        </div>`
      const buttonPart = html` <div class="action-buttons">
        <button id="continue-conversation-btn">Continue Conversation</button>
      </div>`
      // The current button action code only works in VSCode. Need to research and implement another mechanism for Cursor
      const shouldShowContinueButton = detectAppType() === AppType.VSCODE
      return conversationPart + (shouldShowContinueButton ? buttonPart : '')
    }
  }

  // No conversation data available
  return ''
}

export const blameInfoSection = (
  blameInfoState: 'IDLE' | 'LOADING' | 'SUCCESS' | 'ERROR',
  blameInfoError?: string
): string => {
  // IDLE can occur briefly before the controller sets LOADING (or if the panel
  // is shown without triggering a request). Returning a non-empty placeholder
  // prevents the template from falling through to the "human-written" message.
  if (blameInfoState === 'IDLE') {
    return html`<div class="blame-info-loading">
      <div class="spinner"></div>
      <span>Loading blame information...</span>
    </div>`
  }

  // Show loading spinner
  if (blameInfoState === 'LOADING') {
    return html`<div class="blame-info-loading">
      <div class="spinner"></div>
      <span>Loading blame information...</span>
    </div>`
  }

  // Show error message
  if (blameInfoState === 'ERROR') {
    const errorMessage = blameInfoError || 'Failed to load blame information'
    return html`<div class="blame-info-error">
      <span>${escapeHtml(errorMessage)}</span>
    </div>`
  }

  // For SUCCESS or IDLE states, return empty string - content will be handled by caller
  return ''
}

export const noAttributeInfo = (): string => html`
  <div class="human-info">
    <span>No attribution information available for this line.</span>
  </div>
`
