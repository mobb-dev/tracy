import * as os from 'node:os'
import * as stream from 'node:stream'
import * as util from 'node:util'

import fetch from 'cross-fetch'
import pino, { LoggerOptions } from 'pino'
import pretty from 'pino-pretty'
import * as vscode from 'vscode'

import { DD_RUM_TOKEN, EXTENSION_NAME, EXTENSION_VERSION } from '../env'

let vscodeOutputChannel: vscode.OutputChannel | undefined

const { debug, info } = pino.levels.values

const loggerOptions: LoggerOptions = {
  formatters: {
    level: (label) => ({ level: label }),
  },
}

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

const ddStream = new stream.Writable({
  write(chunk, encoding, callback) {
    // Send to Datadog asynchronously without blocking
    fetch('https://http-intake.logs.datadoghq.com/api/v2/logs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'DD-API-KEY': DD_RUM_TOKEN,
      },
      body: JSON.stringify([
        {
          hostname: `${os.userInfo().username}@${os.hostname()}`,
          ddsource: 'VS Code Mobb AI Tracer',
          service: EXTENSION_NAME,
          ddtags: `version:${EXTENSION_VERSION}`,
          message: chunk.toString(),
        },
      ]),
    })
      .catch((error) => {
        vscodeOutputChannel?.appendLine(
          `Error sending log to Datadog: ${util.inspect(error)}`
        )
      })
      .then(() => callback())
  },
})

export const logger = pino(
  loggerOptions,
  pino.multistream([
    {
      stream: prettyStream,
      level: debug,
    },
    {
      stream: ddStream,
      level: info,
    },
  ])
)

export function initLogger() {
  vscodeOutputChannel = vscode.window.createOutputChannel(EXTENSION_NAME)
}
