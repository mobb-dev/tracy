import type { InfoPanelData, WebviewContext } from '../../types'
import { baseLayout } from '../base'
import {
  conversationSection,
  fileHeader,
  humanInfo,
  metaInfo,
} from '../components'
import { html } from '../html'

export const infoPanelTemplate = (
  ctx: WebviewContext,
  data: InfoPanelData
): string => {
  const { fileName, lineNumber, attribution, repoUrl, conversation } = data

  let body = fileHeader(fileName, lineNumber)

  if (attribution) {
    const commitUrl =
      repoUrl && attribution.commitSha
        ? `${repoUrl}/commit/${attribution.commitSha}`
        : undefined

    body += metaInfo(
      attribution.model,
      attribution.toolName,
      attribution.commitSha,
      commitUrl
    )
    body += conversationSection(conversation)
  } else {
    body += humanInfo()
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
    </script>
  `

  return baseLayout(ctx, {
    title: 'Tracey AI Information',
    body,
    scripts,
  })
}
