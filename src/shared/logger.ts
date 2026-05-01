import * as stream from 'node:stream'

import pretty from 'pino-pretty'
import * as vscode from 'vscode'

import { DD_RUM_TOKEN, EXTENSION_NAME, EXTENSION_VERSION } from '../env'
import { createLogger, type Logger } from '../mobbdev_src/utils/shared-logger'

let vscodeOutputChannel: vscode.OutputChannel | undefined

const PERF_CYCLE_MSGS = [
  'copilot poll cycle',
  'cursor poll cycle',
  'cursor tab cycle',
]

const vscodeLogStream = new stream.Writable({
  objectMode: false,
  write(chunk, encoding, callback) {
    const str = chunk.toString()
    if (PERF_CYCLE_MSGS.some((msg) => str.includes(msg))) {
      callback()
      return
    }
    vscodeOutputChannel?.append(str)
    callback()
  },
})

const prettyStream = pretty({
  colorize: false,
  destination: vscodeLogStream,
})

/**
 * Guards against recursion when logging a DD-ship failure through the same
 * logger (which will itself try to ship to DD). The flag is flipped true only
 * for the duration of the warn() call; nested onError invocations fall back
 * to the local VS Code output channel and don't re-enter the logger.
 */
let handlingDdError = false

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
      // Always keep the local trail so IDE users can still see it immediately.
      vscodeOutputChannel?.appendLine(String(error))
      if (handlingDdError) {
        return
      }
      // Route through the standard logger so the failure lands in configstore
      // logs and ships to DD itself once connectivity recovers — uniform with
      // every other warn in the extension.
      handlingDdError = true
      try {
        sharedLogger.warn(
          { err: String(error), source: 'dd-log-shipping' },
          'Datadog log shipping failed'
        )
      } finally {
        handlingDdError = false
      }
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

/**
 * Update DDtags with platform/environment info once repoInfo is available.
 * Must be called after initRepoInfo() since appType and ideVersion
 * are not known at logger creation time.
 */
export function updateLoggerPlatformTags(
  appType: string,
  ideVersion: string
): void {
  const tags = [
    `version:${EXTENSION_VERSION}`,
    `platform:${appType}`,
    `os:${process.platform}`,
    `arch:${process.arch}`,
    `ide_version:${ideVersion}`,
  ].join(',')
  sharedLogger.updateDdTags(tags)
}

export function flushLogger(): void {
  sharedLogger.disposeDd()
}
