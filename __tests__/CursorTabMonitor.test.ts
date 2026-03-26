import { setTimeout } from 'node:timers/promises'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'

import { AcceptanceTracker } from '../src/cursor_tab/AcceptanceTracker'
import { CursorTabMonitor } from '../src/cursor_tab/CursorTabMonitor'
import { AppType } from '../src/shared/repositoryInfo'
import * as uploader from '../src/shared/uploader'

vi.mock('../src/shared/repositoryInfo', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/shared/repositoryInfo')>()
  return {
    ...actual,
    getNormalizedRepoUrl: vi
      .fn()
      .mockResolvedValue('https://github.com/test-org/test-repo'),
  }
})

vi.mock('../src/shared/config', () => ({
  getConfig: vi.fn(() => ({
    apiUrl: 'https://api.mobb.ai/v1/graphql',
    webAppUrl: 'https://app.mobb.ai',
    extensionVersion: '0.1.0',
  })),
}))

vi.mock('vscode', () => {
  return {
    env: {
      appName: 'Cursor',
    },
    window: {
      createOutputChannel: vi.fn(() => ({
        appendLine: vi.fn(),
      })),
      onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
      activeTextEditor: {
        document: {
          uri: { toString: () => 'file:///test/file.ts' },
        },
      },
    },
    workspace: {
      textDocuments: [],
      asRelativePath: (_uri: unknown) => 'file.ts',
      onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
    },
  }
})

vi.mock('../src/shared/logger', () => {
  return {
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  }
})

const uploadTracyRecordsSpy = vi.spyOn(uploader, 'uploadTracyRecords')

describe('CursorTabMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    uploadTracyRecordsSpy.mockClear()
  })

  it('should process log entries and upload cursor changes on happy flow', async () => {
    uploadTracyRecordsSpy.mockResolvedValue()

    const monitor = new CursorTabMonitor(
      {
        logPath: '/tmp',
        subscriptions: [],
      } as vscode.ExtensionContext,
      AppType.CURSOR,
      10
    )

    // Initialize the acceptance tracker that immediately calls back (simulating acceptance)
    ;(monitor as any).acceptanceTracker = new AcceptanceTracker((additions) => {
      ;(monitor as any).uploadAcceptedCompletion(additions)
    })
    ;(monitor as any).activeEditorUri = 'file:///test/file.ts'

    const additions =
      'this is a long cursor tab completion line 1\nthis is a long cursor tab completion line 2'

    ;(monitor as any).processLogEntries(
      '+|this is a long cursor tab completion line 1\n+|this is a long cursor tab completion line 2\n'
    )

    // Simulate the document change that triggers acceptance
    const documentChangeHandler = vi.mocked(
      vscode.workspace.onDidChangeTextDocument
    ).mock.calls[0][0] as (event: vscode.TextDocumentChangeEvent) => void

    documentChangeHandler({
      document: { uri: { toString: () => 'file:///test/file.ts' } },
      contentChanges: [{ text: additions }],
    } as unknown as vscode.TextDocumentChangeEvent)

    // Upload is scheduled via a Promise chain (getNormalizedRepoUrl → uploadTracyRecords).
    // Two microtask ticks needed for the .then() chain to resolve.
    await setTimeout(0)
    await setTimeout(0)

    expect(uploadTracyRecordsSpy).toHaveBeenCalledOnce()

    const record = uploadTracyRecordsSpy.mock.calls.at(0)?.at(0)?.at(0)
    expect(record.additions).toBe(additions)
    expect(record.platform).toBe('CURSOR')
    expect(record.editType).toBe('TAB_AUTOCOMPLETE')
    expect(record.filePath).toBe('file:///test/file.ts')
  })

  it('should filter out human-written lines that appear in both removed and added sections', async () => {
    uploadTracyRecordsSpy.mockResolvedValue()

    const monitor = new CursorTabMonitor(
      {
        logPath: '/tmp',
        subscriptions: [],
      } as vscode.ExtensionContext,
      AppType.CURSOR,
      10
    )

    // Initialize the acceptance tracker that immediately calls back (simulating acceptance)
    ;(monitor as any).acceptanceTracker = new AcceptanceTracker((additions) => {
      ;(monitor as any).uploadAcceptedCompletion(additions)
    })
    ;(monitor as any).activeEditorUri = 'file:///test/file.ts'

    const expectedAdditions = 'return {\n    model: change.model,\n  }\n}'

    // Simulate a diff where the first line appears in both - and + (human-written)
    // Only truly AI-generated lines should be included
    ;(monitor as any).processLogEntries(
      '-|export function uploadChange(change: ProcessedChange) {\n+|export function uploadChange(change: ProcessedChange) {\n+|return {\n+|    model: change.model,\n+|  }\n+|}'
    )

    // Simulate the document change that triggers acceptance
    const documentChangeHandler = vi.mocked(
      vscode.workspace.onDidChangeTextDocument
    ).mock.calls[0][0] as (event: vscode.TextDocumentChangeEvent) => void

    documentChangeHandler({
      document: { uri: { toString: () => 'file:///test/file.ts' } },
      contentChanges: [{ text: expectedAdditions }],
    } as unknown as vscode.TextDocumentChangeEvent)

    // Upload is scheduled via a Promise chain (getNormalizedRepoUrl → uploadTracyRecords).
    // Two microtask ticks needed for the .then() chain to resolve.
    await setTimeout(0)
    await setTimeout(0)

    expect(uploadTracyRecordsSpy).toHaveBeenCalledOnce()

    const record = uploadTracyRecordsSpy.mock.calls.at(0)?.at(0)?.at(0)
    // The first line should be filtered out because it appears in both - and +
    expect(record.additions).toBe(expectedAdditions)
    expect(record.editType).toBe('TAB_AUTOCOMPLETE')
  })
})
