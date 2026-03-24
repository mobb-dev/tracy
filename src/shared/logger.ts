import * as stream from 'node:stream'

import pretty from 'pino-pretty'
import * as vscode from 'vscode'

import { DD_RUM_TOKEN, EXTENSION_NAME, EXTENSION_VERSION } from '../env'
import { createLogger, type Logger } from '../mobbdev_src/utils/shared-logger'

let vscodeOutputChannel: vscode.OutputChannel | undefined

const vscodeLogStream = new stream.Writable({
  objectMode: false,
  write(chunk, encoding, callback) {
    vscodeOutputChannel?.append(chunk.toString())
    callback()
  },
})

const prettyStream = pretty({
  colorize: false,
  destination: vscodeLogStream,
})

const sharedLogger: Logger = createLogger({
  namespace: 'mobb-tracer-logs',
  buffered: false,
  dd: {
    apiKey: DD_RUM_TOKEN,
    ddsource: 'VS Code Mobb AI Tracer',
    service: EXTENSION_NAME,
    ddtags: `version:${EXTENSION_VERSION}`,
    hostnameMode: 'plain',
    onError: (error) => {
      vscodeOutputChannel?.appendLine(String(error))
    },
  },
  additionalStreams: [
    {
      stream: prettyStream,
      level: 'debug',
    },
  ],
})

export const logger = sharedLogger

export function initLogger() {
  vscodeOutputChannel = vscode.window.createOutputChannel(EXTENSION_NAME)

  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (workspacePath) {
    sharedLogger.setScopePath(workspacePath)
  }
}

export function flushLogger(): void {
  sharedLogger.disposeDd()
}
