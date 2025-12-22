import { beforeEach, describe, expect, it, vi } from 'vitest'

import { HumanTrackingSession } from '../src/human/HumanMonitor'
import { initLogger } from '../src/shared/logger'

// Minimal shapes used by our mock
type FakeDisposable = { dispose(): void }
type FakeUri = { scheme: string; toString(): string }
type FakeDoc = {
  uri: FakeUri
  fileName: string
  lineAt: (ln: number) => { text: string }
}

type FakeChangeEvent = {
  document: FakeDoc
  contentChanges: Array<{
    range: {
      start: { line: number; character: number }
      end: { line: number; character: number }
      isEmpty: boolean
    }
    rangeOffset: number
    rangeLength: number
    text: string
  }>
}

type Hoisted = {
  outputLines: string[]
  textDocs: FakeDoc[]
  changeListeners: Array<(e: FakeChangeEvent) => void>
  cmdListener: ((e: { command?: string }) => unknown) | null
  activeDoc: FakeDoc | null
}

const h = vi.hoisted(() => {
  return {
    outputLines: [] as string[],
    textDocs: [] as FakeDoc[],
    changeListeners: [] as Array<(e: FakeChangeEvent) => void>,
    cmdListener: null as ((e: { command?: string }) => unknown) | null,
    activeDoc: null as FakeDoc | null,
  }
}) as unknown as Hoisted

vi.useFakeTimers()

vi.mock('../src/human/config', async () => {
  const cfg = await vi.importActual<typeof import('../src/human/config')>(
    '../src/human/config'
  )

  return {
    HUMAN_TRACKING_CONFIG: {
      ...cfg.HUMAN_TRACKING_CONFIG,
      uploadEnabled: false,
    },
  }
})

// Mock logger so human tracker DRY-RUN upload logs are captured in
// h.outputLines without depending on the real VS Code output channel
// or cross-file logger mocks.
vi.mock('../src/shared/logger', () => {
  const { outputLines } = h as Hoisted
  return {
    initLogger: vi.fn(),
    logger: {
      info: (message: unknown, options?: { isJson?: boolean }) => {
        const text = options?.isJson
          ? JSON.stringify(message)
          : String(message ?? '')
        outputLines.push(text)
      },
      debug: (message: unknown, options?: { isJson?: boolean }) => {
        const text = options?.isJson
          ? JSON.stringify(message)
          : String(message ?? '')
        outputLines.push(text)
      },
      error: vi.fn(),
    },
  }
})

// Mock VS Code API used by the human tracker
vi.mock('vscode', () => {
  const { outputLines } = h as Hoisted
  return {
    Disposable: class {
      private _cb: () => void
      constructor(cb: () => void) {
        this._cb = cb
      }
      dispose() {
        this._cb()
      }
    },
    window: {
      createOutputChannel: vi.fn(() => ({
        appendLine: (m: string) => outputLines.push(m),
      })),
      get activeTextEditor() {
        const active = (h as Hoisted).activeDoc
        return active
          ? {
              document: active,
            }
          : undefined
      },
    },
    commands: {},
    workspace: {
      get textDocuments() {
        return (h as Hoisted).textDocs
      },
      asRelativePath: (_uri: unknown) => 'file.ts',
      onDidChangeTextDocument: (listener: (e: FakeChangeEvent) => unknown) => {
        ;(h as Hoisted).changeListeners.push(listener)
        const d: FakeDisposable = { dispose: () => void 0 }
        return d
      },
      onDidCloseTextDocument: () => {
        const d: FakeDisposable = { dispose: () => void 0 }
        return d
      },
    },
  }
})

// Mock network upload module to avoid Node-version checks / network
vi.mock('../src/mobbdev_src/args/commands/upload_ai_blame', () => ({
  uploadAiBlameHandlerFromExtension: vi.fn().mockResolvedValue({
    promptsCounts: {
      pii: { total: 0, high: 0, medium: 0, low: 0 },
      secrets: 0,
    },
    inferenceCounts: {
      pii: { total: 0, high: 0, medium: 0, low: 0 },
      secrets: 0,
    },
    promptsUUID: 'test-prompts-uuid',
    inferenceUUID: 'test-inference-uuid',
  }),
}))

// Mock config to disable actual uploads (use DRY-RUN mode)
vi.mock('../src/human/config', () => ({
  HUMAN_TRACKING_CONFIG: {
    segmentIdleMs: 30000,
    segmentMaxChars: 10000,
    adjacencyGapLines: 1,
    maxSegmentDurationMs: 60000,
    minSegmentCharsWithNoWhitespace: 30,
    uploadEnabled: false, // Set to false for DRY-RUN mode
    classifier: {
      largeSingleInsertThreshold: 10,
    },
  },
}))

function makeDoc(lines: string[]): FakeDoc {
  return {
    uri: { scheme: 'file', toString: () => 'file:///ws/file.ts' },
    fileName: '/ws/file.ts',
    lineAt: (ln: number) => ({ text: lines[ln] ?? '' }),
  }
}

function fireChange(
  doc: FakeDoc,
  changes: Array<{ line: number; text: string }>
) {
  const event = {
    document: doc,
    contentChanges: changes.map(({ line, text }) => ({
      range: {
        start: { line, character: 0 },
        end: { line, character: 0 },
        // VS Code uses an empty range for pure insertions
        // (start === end, isEmpty === true) even when text is
        // non-empty. Our segmentation logic relies on this to
        // decide whether the line should be included in the
        // half-open interval [start, end).
        //
        // To mirror real events, model these synthetic changes
        // as insertions so that the segmenter includes the line
        // in the segment span.
        isEmpty: true,
      },
      rangeOffset: 0,
      rangeLength: 0,
      text,
    })),
  }
  for (const l of h.changeListeners) {
    l(event)
  }
}

function fireMultiChange(
  doc: FakeDoc,
  changes: Array<{ line: number; text: string }>
) {
  const event = {
    document: doc,
    contentChanges: changes.map(({ line, text }) => ({
      range: {
        start: { line, character: 0 },
        end: { line, character: 0 },
        // See note in fireChange: we model these as pure insert
        // events so that the segmenter treats the line as
        // affected and includes it in the segment span.
        isEmpty: true,
      },
      rangeOffset: 0,
      rangeLength: 0,
      text,
    })),
  } as unknown as FakeChangeEvent
  for (const l of h.changeListeners) {
    l(event)
  }
}

beforeEach(() => {
  h.outputLines.length = 0
  h.textDocs.length = 0
  h.changeListeners.length = 0
  h.cmdListener = null
  h.activeDoc = null
  vi.clearAllMocks()
})

describe('Human tracker — idle flush behavior', () => {
  it('emits a DRY-RUN upload log for a single human edit on a long line after idle', async () => {
    // Arrange: line 0 is long enough to exceed minSegmentCharsWithNoWhitespace
    const doc = makeDoc(['abcdefghijklmnopqrstuvwxyz1234567890', 'b', 'c'])
    h.textDocs.push(doc)
    h.activeDoc = doc

    const ctx = {
      subscriptions: [],
    } as unknown as import('vscode').ExtensionContext
    initLogger()
    const monitor = new HumanTrackingSession(ctx)
    monitor.start()

    // First human edit to open a segment
    vi.setSystemTime(new Date(0))
    fireChange(doc, [{ line: 0, text: 'X' }])

    // Advance timers to trigger idle flush (~segmentIdleMs = 30000ms)
    await vi.runAllTimersAsync()

    // We expect at least one DRY-RUN upload log for the
    // human segment when the idle flush force-closes it.
    await vi.waitFor(() => {
      const dryRunLogs = h.outputLines.filter((l) =>
        l.includes('DRY-RUN (upload disabled)')
      )
      expect(dryRunLogs.length).toBeGreaterThanOrEqual(1)
    })

    monitor.stop()
  })
})

describe('Human tracker — purely non-human events', () => {
  it('does not log DRY-RUN upload for a multi-change event with no prior human edits', async () => {
    const doc = makeDoc(['line 0', 'line 1'])
    h.textDocs.push(doc)
    h.activeDoc = doc

    const ctx = {
      subscriptions: [],
    } as unknown as import('vscode').ExtensionContext
    initLogger()
    const monitor = new HumanTrackingSession(ctx)
    monitor.start()

    // Fire a multi-change event directly (formatter-like change) without
    // any preceding human edits.
    fireMultiChange(doc, [
      { line: 0, text: 'formatted 0' },
      { line: 1, text: 'formatted 1' },
    ])

    // Let any scheduled idle timers run.
    vi.advanceTimersByTime(30001)
    await Promise.resolve()

    const dryRunLogs = h.outputLines.filter((l) =>
      l.includes('DRY-RUN (upload disabled)')
    )
    expect(dryRunLogs.length).toBe(0)

    monitor.stop()
  })

  it('does not log DRY-RUN upload for a large single-insert event with no prior human edits', async () => {
    const doc = makeDoc(['original line'])
    h.textDocs.push(doc)
    h.activeDoc = doc

    const ctx = {
      subscriptions: [],
    } as unknown as import('vscode').ExtensionContext
    initLogger()
    const monitor = new HumanTrackingSession(ctx)
    monitor.start()

    // Fire a large single insertion (above largeSingleInsertThreshold)
    // without any preceding human edits.
    fireChange(doc, [{ line: 0, text: 'x'.repeat(100) }])

    // Let any scheduled idle timers run.
    vi.advanceTimersByTime(30001)
    await Promise.resolve()

    const dryRunLogs = h.outputLines.filter((l) =>
      l.includes('DRY-RUN (upload disabled)')
    )
    expect(dryRunLogs.length).toBe(0)

    monitor.stop()
  })
})
