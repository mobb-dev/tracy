import * as fs from 'node:fs'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

import * as tmp from 'tmp-promise'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'

import { CursorTabMonitor } from '../src/cursor_tab/CursorTabMonitor'
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

    const tempDir = await tmp.dir({
      unsafeCleanup: true,
    })

    try {
      fs.mkdirSync(join(tempDir.path, 'dummy/'))
      fs.mkdirSync(join(tempDir.path, 'anysphere.cursor-always-local/'))
      fs.writeFileSync(
        join(tempDir.path, 'anysphere.cursor-always-local/Cursor Tab.log'),
        'bla bla \n+|a\n+|b\n+|c\n'
      )

      const monitor = new CursorTabMonitor(
        {
          logPath: join(tempDir.path, 'dummy/'),
          subscriptions: [],
        } as vscode.ExtensionContext,
        10
      )

      await monitor.start()

      fs.appendFileSync(
        join(tempDir.path, 'anysphere.cursor-always-local/Cursor Tab.log'),
        '+|d\n+|e\n+|f\n'
      )

      // Wait 10x longer than fsWatchInterval.
      await setTimeout(100)

      expect(uploadCursorChangesSpy).toHaveBeenCalledOnce()

      const change = uploadCursorChangesSpy.mock.calls.at(0).at(0).at(0)
      expect(change.additions).toBe('d\ne\nf')
    } finally {
      await tempDir.cleanup()
    }
  })
})
