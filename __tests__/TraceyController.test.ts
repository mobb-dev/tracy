import { afterEach, describe, expect, it, vi } from 'vitest'

// Mock vscode
const mockVSCode = {
  window: {
    activeTextEditor: null,
    onDidChangeActiveTextEditor: vi.fn(),
    onDidChangeTextEditorSelection: vi.fn(),
  },
  commands: {
    registerCommand: vi.fn(),
  },
  Uri: {
    parse: vi.fn(),
  },
  ViewColumn: {
    Beside: 2,
  },
}

vi.mock('vscode', () => mockVSCode)

// Mock logger
vi.mock('../src/shared/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

describe('TraceyController', () => {
  afterEach(() => {
    vi.resetAllMocks()
  })

  describe('file validation', () => {
    it('accepts valid file URIs', async () => {
      const { TraceyController } = await import('../src/ui/TraceyController')

      const mockGitCache = {
        getBlameLine: vi.fn(),
        dispose: vi.fn(),
      }
      const mockAiBlameCache = {
        getAIBlameInfoLine: vi.fn(),
        dispose: vi.fn(),
      }
      const mockView = {
        refresh: vi.fn(),
        error: vi.fn(),
      }

      const controller = new TraceyController(
        mockGitCache as any,
        mockAiBlameCache as any,
        mockView as any,
        'repo-url'
      )

      // Use reflection to access private method
      const isValidFile = (controller as any).isValidFile.bind(controller)

      const validDoc = {
        uri: { scheme: 'file', fsPath: '/repo/src/file.ts' },
        isUntitled: false,
      }

      expect(isValidFile(validDoc)).toBe(true)
    })

    it('rejects non-file URI schemes', async () => {
      const { TraceyController } = await import('../src/ui/TraceyController')
      const { logger } = await import('../src/shared/logger')

      const mockView = {
        refresh: vi.fn(),
        error: vi.fn(),
      }

      const controller = new TraceyController(
        {} as any,
        {} as any,
        mockView as any,
        'repo-url'
      )
      const isValidFile = (controller as any).isValidFile.bind(controller)

      const nonFileDoc = {
        uri: { scheme: 'output', toString: () => 'output://extension-output' },
        isUntitled: false,
      }

      expect(isValidFile(nonFileDoc)).toBe(false)
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Skipping non-file URI')
      )
    })

    it('rejects untitled documents', async () => {
      const { TraceyController } = await import('../src/ui/TraceyController')
      const { logger } = await import('../src/shared/logger')

      const mockView = {
        refresh: vi.fn(),
        error: vi.fn(),
      }

      const controller = new TraceyController(
        {} as any,
        {} as any,
        mockView as any,
        'repo-url'
      )
      const isValidFile = (controller as any).isValidFile.bind(controller)

      const untitledDoc = {
        uri: { scheme: 'file', toString: () => 'untitled:Untitled-1' },
        isUntitled: true,
      }

      expect(isValidFile(untitledDoc)).toBe(false)
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Skipping untitled document')
      )
    })

    it('rejects VS Code internal documents', async () => {
      const { TraceyController } = await import('../src/ui/TraceyController')
      const { logger } = await import('../src/shared/logger')

      const mockView = {
        refresh: vi.fn(),
        error: vi.fn(),
      }

      const controller = new TraceyController(
        {} as any,
        {} as any,
        mockView as any,
        'repo-url'
      )
      const isValidFile = (controller as any).isValidFile.bind(controller)

      const internalDoc = {
        uri: {
          scheme: 'file',
          fsPath: '/path/extension-output/something',
          toString: () => 'file:///path/extension-output/something',
        },
        isUntitled: false,
      }

      expect(isValidFile(internalDoc)).toBe(false)
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Skipping internal document')
      )
    })
  })

  describe('stale request prevention', () => {
    it('ignores stale blame updates', async () => {
      vi.useFakeTimers()

      const { TraceyController } = await import('../src/ui/TraceyController')
      const { logger } = await import('../src/shared/logger')

      // Mock slow git blame response
      const mockGitCache = {
        getBlameLine: vi
          .fn()
          .mockImplementation(
            () =>
              new Promise((resolve) =>
                setTimeout(
                  () => resolve({ commit: 'abc123', originalLine: 10 }),
                  100
                )
              )
          ),
        dispose: vi.fn(),
      }

      // Mock fast AI blame response
      const mockAiBlameCache = {
        getAIBlameInfoLine: vi.fn().mockResolvedValue({ type: 'CHAT' }),
        dispose: vi.fn(),
      }

      const mockView = {
        refresh: vi.fn(),
        error: vi.fn(),
      }

      const controller = new TraceyController(
        mockGitCache as any,
        mockAiBlameCache as any,
        mockView as any,
        'repo-url'
      )

      const mockDoc = {
        uri: { fsPath: '/repo/file.ts' },
        fileName: '/repo/file.ts',
        isDirty: false,
      }

      // Start first update
      const updatePromise1 = (controller as any).updateBlameInfo(mockDoc, 1)

      // Immediately start second update (this should make first one stale)
      const updatePromise2 = (controller as any).updateBlameInfo(mockDoc, 2)

      // Fast-forward time to resolve promises
      vi.advanceTimersByTime(200)

      await Promise.all([updatePromise1, updatePromise2])

      // Should log about skipping stale request
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Skipping stale blame update')
      )

      vi.useRealTimers()
    })

    it('processes requests with different request IDs correctly', async () => {
      const { TraceyController } = await import('../src/ui/TraceyController')

      const mockGitCache = {
        getBlameLine: vi
          .fn()
          .mockResolvedValue({ commit: 'abc123', originalLine: 10 }),
        dispose: vi.fn(),
      }

      const mockAiBlameCache = {
        getAIBlameInfoLine: vi.fn().mockResolvedValue({ type: 'CHAT' }),
        dispose: vi.fn(),
      }

      const mockView = {
        refresh: vi.fn(),
        error: vi.fn(),
      }

      const controller = new TraceyController(
        mockGitCache as any,
        mockAiBlameCache as any,
        mockView as any,
        'repo-url'
      )

      const mockDoc = {
        uri: { fsPath: '/repo/file.ts' },
        fileName: '/repo/file.ts',
        isDirty: false,
      }

      // Process update
      await (controller as any).updateBlameInfo(mockDoc, 1)

      // Should have called refresh with AI state
      expect(mockView.refresh).toHaveBeenCalledWith('ai')
    })
  })

  describe('state management', () => {
    it('updates current state correctly', async () => {
      const { TraceyController } = await import('../src/ui/TraceyController')

      const mockGitCache = {
        getBlameLine: vi
          .fn()
          .mockResolvedValue({ commit: 'abc123', originalLine: 10 }),
        dispose: vi.fn(),
      }

      const mockAiBlameCache = {
        getAIBlameInfoLine: vi.fn().mockResolvedValue({
          type: 'HUMAN_EDIT',
          id: 'attr-1',
        }),
        dispose: vi.fn(),
      }

      const mockView = {
        refresh: vi.fn(),
        error: vi.fn(),
      }

      const controller = new TraceyController(
        mockGitCache as any,
        mockAiBlameCache as any,
        mockView as any,
        'repo-url'
      )

      const mockDoc = {
        uri: { fsPath: '/repo/file.ts' },
        fileName: '/repo/file.ts',
        isDirty: false,
      }

      await (controller as any).updateBlameInfo(mockDoc, 5)

      // Check that internal state was updated
      expect((controller as any).currentFilePath).toBe('/repo/file.ts')
      expect((controller as any).currentLineNumber).toBe(5)
      expect((controller as any).currentAttribution).toEqual({
        type: 'HUMAN_EDIT',
        id: 'attr-1',
      })

      // Should refresh with HUMAN state
      expect(mockView.refresh).toHaveBeenCalledWith('human')
    })

    it('handles dirty files correctly', async () => {
      const { TraceyController } = await import('../src/ui/TraceyController')

      const mockView = {
        refresh: vi.fn(),
        error: vi.fn(),
      }

      const controller = new TraceyController(
        {} as any,
        {} as any,
        mockView as any,
        'repo-url'
      )

      const dirtyDoc = {
        uri: { fsPath: '/repo/file.ts' },
        fileName: '/repo/file.ts',
        isDirty: true,
      }

      await (controller as any).updateBlameInfo(dirtyDoc, 1)

      // Should refresh with NO_DATA for dirty files
      expect(mockView.refresh).toHaveBeenCalledWith('no-data')
    })
  })
})
