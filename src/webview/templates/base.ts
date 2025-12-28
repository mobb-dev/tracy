import type { WebviewContext } from '../types'
import { html } from './html'

type LayoutOptions = {
  title: string
  body: string
  scripts?: string
}

export const baseLayout = (
  ctx: WebviewContext,
  options: LayoutOptions
): string => html`
  <!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta
        http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${ctx.nonce}';"
      />
      <title>${options.title}</title>
      <style>
        body {
          font-family: var(--vscode-font-family);
          font-size: var(--vscode-font-size);
          color: var(--vscode-foreground);
          background-color: var(--vscode-editor-background);
          padding: 16px;
          line-height: 1.6;
          margin: 0;
        }
        h2,
        h3 {
          color: var(--vscode-textPreformat-foreground);
          margin-top: 0;
          margin-bottom: 12px;
        }
        .file-info {
          color: var(--vscode-descriptionForeground);
          margin-bottom: 8px;
        }
        .meta-info {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          margin-bottom: 8px;
        }
        .meta-item {
          font-size: 0.9em;
          padding: 4px 8px;
          background-color: var(--vscode-badge-background);
          border-radius: 4px;
          color: var(--vscode-badge-foreground);
        }
        .meta-link {
          cursor: pointer;
          text-decoration: underline;
        }
        .meta-link:hover {
          background-color: var(--vscode-button-hoverBackground);
        }
        .human-info {
          padding: 12px;
          background-color: var(--vscode-inputValidation-infoBackground);
          border-radius: 6px;
          text-align: center;
        }
        .action-buttons {
          margin-top: 16px;
          text-align: center;
        }
        hr {
          border: none;
          border-top: 1px solid var(--vscode-textSeparator-foreground);
          margin: 16px 0;
        }
        button {
          background-color: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          border: none;
          padding: 10px 16px;
          border-radius: 4px;
          cursor: pointer;
          font-family: var(--vscode-font-family);
          font-size: var(--vscode-font-size);
        }
        button:hover {
          background-color: var(--vscode-button-hoverBackground);
        }
        .conversation {
          max-height: 400px;
          overflow-y: auto;
          border: 1px solid var(--vscode-textSeparator-foreground);
          border-radius: 8px;
          padding: 12px;
          background-color: var(--vscode-input-background);
        }
        .user-message,
        .ai-message {
          margin-bottom: 16px;
          padding: 12px;
          border-radius: 8px;
          max-width: 80%;
        }
        .user-message {
          margin-left: auto;
          background-color: var(--vscode-inputOption-activeBackground);
          text-align: right;
        }
        .ai-message {
          margin-right: auto;
          background-color: var(--vscode-badge-background);
          text-align: left;
        }
        .message-header {
          display: flex;
          align-items: center;
          margin-bottom: 8px;
          font-size: 0.9em;
          opacity: 0.8;
        }
        .user-message .message-header {
          justify-content: flex-end;
        }
        .ai-message .message-header {
          justify-content: flex-start;
        }
        .avatar {
          margin: 0 6px;
        }
        .timestamp {
          font-size: 0.8em;
        }
        .message-content {
          word-wrap: break-word;
          white-space: pre-wrap;
        }
      </style>
    </head>
    <body>
      ${options.body} ${options.scripts ?? ''}
    </body>
  </html>
`
