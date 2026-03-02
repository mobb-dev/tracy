import * as os from 'node:os'
import * as stream from 'node:stream'
import * as util from 'node:util'

import fetch from 'cross-fetch'
import pino, { LoggerOptions } from 'pino'
import pretty from 'pino-pretty'
import * as vscode from 'vscode'

import { DD_RUM_TOKEN, EXTENSION_NAME, EXTENSION_VERSION } from '../env'
import { logError, logWarn } from './circularLog'

let vscodeOutputChannel: vscode.OutputChannel | undefined
let ddErrorLogged = false

const { debug, info, warn } = pino.levels.values

// Datadog batching: collect logs and flush periodically instead of one HTTP POST per log
const DD_BATCH_INTERVAL_MS = 5_000
const DD_BATCH_MAX_SIZE = 50
let ddBatch: Record<string, unknown>[] = []
let ddFlushTimer: ReturnType<typeof setInterval> | null = null

function ddFlush(): void {
  if (ddBatch.length === 0) {
    return
  }
  const batch = ddBatch
  ddBatch = []

  fetch('https://http-intake.logs.datadoghq.com/api/v2/logs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'DD-API-KEY': DD_RUM_TOKEN,
    },
    body: JSON.stringify(batch),
  }).catch((error) => {
    if (!ddErrorLogged) {
      ddErrorLogged = true
      vscodeOutputChannel?.appendLine(
        `Error sending log to Datadog (further errors suppressed): ${util.inspect(error)}`
      )
      logError(
        'Datadog unreachable',
        error instanceof Error ? error.message : String(error)
      )
    }
  })
}

function ddEnqueue(entry: Record<string, unknown>): void {
  ddBatch.push(entry)

  // Start flush timer on first entry
  if (!ddFlushTimer) {
    ddFlushTimer = setInterval(() => {
      ddFlush()
    }, DD_BATCH_INTERVAL_MS)
  }

  // Flush immediately if batch is full
  if (ddBatch.length >= DD_BATCH_MAX_SIZE) {
    ddFlush()
  }
}

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

const ddHostname = `${os.userInfo().username}@${os.hostname()}`

const ddStream = new stream.Writable({
  write(chunk, encoding, callback) {
    // Release pino backpressure immediately
    callback()

    ddEnqueue({
      hostname: ddHostname,
      ddsource: 'VS Code Mobb AI Tracer',
      service: EXTENSION_NAME,
      ddtags: `version:${EXTENSION_VERSION}`,
      message: chunk.toString(),
    })
  },
})

// Pipe warn/error-level pino logs into the configstore ring buffer automatically.
// This ensures every logger.error() and logger.warn() across the codebase is
// captured for crash forensics without modifying each call site.
//
// NOTE: `parsed.level` is a string (e.g. 'warn', 'error') because of the
// custom `formatters.level` in loggerOptions above that converts numeric levels
// to labels. If that formatter changes, the comparison below must be updated.
const configstoreErrorStream = new stream.Writable({
  objectMode: false,
  write(chunk, encoding, callback) {
    callback()
    try {
      const parsed = JSON.parse(chunk.toString())
      const msg = parsed.msg || parsed.message || chunk.toString().trim()
      if (parsed.level === 'warn') {
        logWarn(msg)
      } else {
        logError(msg)
      }
    } catch {
      // If JSON parse fails, log raw message
      logError(chunk.toString().trim())
    }
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
    {
      stream: configstoreErrorStream,
      level: warn,
    },
  ])
)

export function initLogger() {
  vscodeOutputChannel = vscode.window.createOutputChannel(EXTENSION_NAME)
}

export function flushLogger(): void {
  ddFlush()
  if (ddFlushTimer) {
    clearInterval(ddFlushTimer)
    ddFlushTimer = null
  }
}
