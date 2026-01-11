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
        .conversation-loading {
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 32px;
          background-color: var(--vscode-input-background);
          border: 1px solid var(--vscode-textSeparator-foreground);
          border-radius: 8px;
          gap: 12px;
        }
        .conversation-error {
          text-align: center;
          padding: 32px;
          background-color: var(--vscode-inputValidation-errorBackground);
          border: 1px solid var(--vscode-inputValidation-errorBorder);
          border-radius: 8px;
          color: var(--vscode-inputValidation-errorForeground);
        }
        .collapsible-header {
          all: unset;
          cursor: pointer;
          display: flex;
          gap: 0.5em;
          align-items: center;
        }
        .collapsible-content.is-collapsed {
          display: none;
        }
        .blame-info-loading {
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 32px;
          background-color: var(--vscode-input-background);
          border: 1px solid var(--vscode-textSeparator-foreground);
          border-radius: 8px;
          gap: 12px;
        }
        .blame-info-error {
          text-align: center;
          padding: 32px;
          background-color: var(--vscode-inputValidation-errorBackground);
          border: 1px solid var(--vscode-inputValidation-errorBorder);
          border-radius: 8px;
          color: var(--vscode-inputValidation-errorForeground);
        }
        .spinner {
          width: 20px;
          height: 20px;
          border: 2px solid var(--vscode-textSeparator-foreground);
          border-top: 2px solid var(--vscode-focusBorder);
          border-radius: 50%;
          animation: spin 1s linear infinite;
        }
        .conversation-summary h3,
        .conversation-summary h4 {
          margin: 0;
          padding: 0;
          line-height: 1.25;
        }
        .summary-text {
          margin: 0.2em 0 0;
          opacity: 0.9;
          line-height: 1.4;
        }
        .summary-list {
          margin: 0;
          padding-left: 1.1em; /* bullet distance */
        }
        .summary-list li {
          margin: 0.2em 0;
          line-height: 1.4;
        }
        .summary-block,
        .collapsible-section {
          padding: 0.4em 0;
          margin: 0;
        }
        .collapsible-title {
          display: inline;
          margin: 0;
          padding: 0;
          font-weight: 600;
          line-height: 1.2;
        }
        .collapsible-header {
          appearance: none;
          background: transparent !important;
          border: none;
          box-shadow: none;
          padding: 0.2em 0;
          width: 100%;
          text-align: left;
          cursor: pointer;
          color: var(--vscode-foreground);
        }
        .collapsible-header:focus,
        .collapsible-header:active,
        .collapsible-header:focus-visible {
          outline: none;
          background: transparent !important;
        }
        .collapsible-header::selection,
        .collapsible-header *::selection {
          background: transparent;
        }
        .collapsible-header .arrow {
          transition: transform 120ms ease;
        }
        .collapsible-header[aria-expanded='false'] .arrow {
          transform: rotate(-90deg);
        }
        .collapsible-header[aria-expanded='true'] .arrow {
          transform: rotate(0deg);
        }
        .collapsible-content.is-collapsed {
          display: none;
        }
        @keyframes spin {
          0% {
            transform: rotate(0deg);
          }
          100% {
            transform: rotate(360deg);
          }
        }
      </style>
    </head>
    <body>
      ${options.body} ${options.scripts ?? ''}
    </body>
  </html>
`
