import { setTimeout } from 'node:timers/promises'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'

import { CursorTabMonitor } from '../src/cursor_tab/CursorTabMonitor'
import { AppType } from '../src/shared/repositoryInfo'
import * as uploader from '../src/shared/uploader'

vi.mock('vscode', () => {
  return {
    env: {
      appName: 'Cursor',
    },
    window: {
      createOutputChannel: vi.fn(() => ({
        appendLine: vi.fn(),
      })),
    },
    workspace: {
      textDocuments: [],
      asRelativePath: (_uri: unknown) => 'file.ts',
    },
  }
})

vi.mock('../src/shared/logger', () => {
  return {
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
  }
})

const uploadCursorChangesSpy = vi.spyOn(uploader, 'uploadCursorChanges')

describe('CursorTabMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    uploadCursorChangesSpy.mockClear()
  })

  it('should process log entries and upload cursor changes on happy flow', async () => {
    uploadCursorChangesSpy.mockResolvedValue()

    const monitor = new CursorTabMonitor(
      {
        logPath: '/tmp',
        subscriptions: [],
      } as vscode.ExtensionContext,
      AppType.CURSOR,
      10
    )

    ;(monitor as any).processLogEntries(
      '+|this is a long cursor tab completion line 1\n+|this is a long cursor tab completion line 2\n'
    )

    // Upload is scheduled via a Promise chain; allow it to be queued.
    await setTimeout(0)

    expect(uploadCursorChangesSpy).toHaveBeenCalledOnce()

    const change = uploadCursorChangesSpy.mock.calls.at(0).at(0).at(0)
    expect(change.additions).toBe(
      'this is a long cursor tab completion line 1\nthis is a long cursor tab completion line 2'
    )
  })

  it('should filter out human-written lines that appear in both removed and added sections', async () => {
    uploadCursorChangesSpy.mockResolvedValue()

    const monitor = new CursorTabMonitor(
      {
        logPath: '/tmp',
        subscriptions: [],
      } as vscode.ExtensionContext,
      AppType.CURSOR,
      10
    )

    // Simulate a diff where the first line appears in both - and + (human-written)
    // Only truly AI-generated lines should be included
    ;(monitor as any).processLogEntries(
      '-|export function uploadChange(change: ProcessedChange) {\n+|export function uploadChange(change: ProcessedChange) {\n+|return {\n+|    model: change.model,\n+|  }\n+|}'
    )

    // Upload is scheduled via a Promise chain; allow it to be queued.
    await setTimeout(0)

    expect(uploadCursorChangesSpy).toHaveBeenCalledOnce()

    const change = uploadCursorChangesSpy.mock.calls.at(0).at(0).at(0)
    // The first line should be filtered out because it appears in both - and +
    expect(change.additions).toBe('return {\n    model: change.model,\n  }\n}')
  })
})
