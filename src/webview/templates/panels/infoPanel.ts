import * as semver from 'semver'

import { AppType, repoInfo } from '../../../shared/repositoryInfo'
import type { InfoPanelData, WebviewContext } from '../../types'
import { baseLayout } from '../base'
import {
  blameInfoSection,
  conversationSection,
  conversationSummarySection,
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
    conversationSummary,
    conversationSummaryState,
    conversationSummaryError,
    blameInfoState,
    blameInfoError,
  } = data

  let body = ''
  // Only show continue conversation button for chat attributions with successful state
  // For cursor, IDE version needs to be 2.3.34+
  // Other IDE types show the button unconditionally
  if (
    attribution &&
    attribution.type === 'CHAT' &&
    conversationState === 'SUCCESS' &&
    repoInfo &&
    (repoInfo.appType !== AppType.CURSOR ||
      (repoInfo.appType === AppType.CURSOR &&
        semver.gte(repoInfo.ideVersion, '2.3.34')))
  ) {
    body = fileHeader(fileName, lineNumber, true)
  } else {
    body = fileHeader(fileName, lineNumber, false)
  }

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
      commitUrl,
      attribution.authorName,
      attribution.authorTime
    )

    if (attribution.type === 'CHAT') {
      body += conversationSummarySection(
        conversationSummary,
        conversationSummaryState,
        conversationSummaryError
      )
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

      function wireCollapsibles(root = document) {
        root.querySelectorAll('[data-collapsible]').forEach((header) => {
          // avoid double-binding if your webview re-renders content
          if (header.dataset.wired === 'true') return
          header.dataset.wired = 'true'

          header.addEventListener('click', () => {
            const content = header.nextElementSibling
            if (!content) return

            const expanded = header.getAttribute('aria-expanded') === 'true'
            header.setAttribute('aria-expanded', expanded ? 'false' : 'true')
            if (content.classList.contains('is-collapsed')) {
              content.classList.remove('is-collapsed')
            } else {
              content.classList.add('is-collapsed')
            }
          })
        })
      }

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
        wireCollapsibles()
      })
    </script>
  `

  return baseLayout(ctx, {
    title: 'Tracy AI Information',
    body,
    scripts,
  })
}
