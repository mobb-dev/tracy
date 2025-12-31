import type { InfoPanelData, WebviewContext } from '../../types'
import { baseLayout } from '../base'
import {
  blameInfoSection,
  conversationSection,
  fileHeader,
  metaInfo,
  noAttributeInfo,
} from '../components'
import { html } from '../html'

export const infoPanelTemplate = (
  ctx: WebviewContext,
  data: InfoPanelData
): string => {
  const {
    fileName,
    lineNumber,
    attribution,
    repoUrl,
    conversation,
    conversationState,
    conversationError,
    blameInfoState,
    blameInfoError,
  } = data

  let body = fileHeader(fileName, lineNumber)

  // Handle blame info loading states first
  const blameInfoLoadingContent = blameInfoSection(
    blameInfoState,
    blameInfoError
  )
  if (blameInfoLoadingContent) {
    // Show loading or error state for blame info
    body += blameInfoLoadingContent
  } else if (attribution) {
    // Show normal attribution content when blame info loaded successfully
    const commitUrl =
      repoUrl && attribution.commitSha
        ? `${repoUrl}/commit/${attribution.commitSha}`
        : undefined

    let typeInfo = 'Unknown'
    switch (attribution.type) {
      case 'CHAT':
        typeInfo = attribution.model
        break
      case 'HUMAN_EDIT':
        typeInfo = 'Human Edit'
        break
      case 'TAB_AUTOCOMPLETE':
        typeInfo = 'AI Code Completion'
        break
    }

    body += metaInfo(
      typeInfo,
      attribution.toolName,
      attribution.commitSha,
      commitUrl
    )

    if (attribution.type === 'CHAT') {
      body += conversationSection(
        conversation,
        conversationState,
        conversationError
      )
    }
  } else {
    body += noAttributeInfo()
  }

  const scripts = html`
    <script nonce="${ctx.nonce}">
      const vscode = acquireVsCodeApi()

      function continueConversation() {
        vscode.postMessage({ command: 'continueConversation' })
      }

      function openCommit(url) {
        vscode.postMessage({ command: 'openCommitOnGitHub', url: url })
      }

      // Add event listeners when DOM is ready
      document.addEventListener('DOMContentLoaded', () => {
        // For continue conversation button
        const continueBtn = document.getElementById('continue-conversation-btn')
        if (continueBtn) {
          continueBtn.addEventListener('click', continueConversation)
        }

        // For commit links - use data attributes
        document.querySelectorAll('.commit-link').forEach((link) => {
          link.addEventListener('click', (e) => {
            e.preventDefault()
            const currentTarget = e.currentTarget
            const url =
              currentTarget instanceof HTMLElement
                ? currentTarget.dataset.commitUrl
                : undefined
            if (url) {
              openCommit(url)
            }
          })
        })
      })
    </script>
  `

  return baseLayout(ctx, {
    title: 'Tracy AI Information',
    body,
    scripts,
  })
}
