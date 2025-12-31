import { afterEach, describe, expect, it, vi } from 'vitest'

// Mock InfoPanel so we don't create a real webview.
const mockInfoPanelShow = vi.fn().mockResolvedValue(undefined)
const mockInfoPanelUpdateBlameInfoState = vi.fn().mockResolvedValue(undefined)
const mockInfoPanelDispose = vi.fn()

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
    file: vi.fn((fsPath: string) => ({ fsPath })),
  },
  ViewColumn: {
    Beside: 2,
  },
  workspace: {
    openTextDocument: vi.fn(),
  },
}

vi.mock('vscode', () => mockVSCode)

vi.mock('../src/ui/TracyInfoPanel', () => ({
  InfoPanel: class InfoPanel {
    show = mockInfoPanelShow
    updateBlameInfoState = mockInfoPanelUpdateBlameInfoState
    dispose = mockInfoPanelDispose
    constructor() {}
  },
}))

// Mock logger
vi.mock('../src/shared/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

describe('TracyController', () => {
  afterEach(() => {
    vi.resetAllMocks()
  })

  describe('file validation', () => {
    it('accepts valid file URIs', async () => {
      const { TracyController } = await import('../src/ui/TracyController')

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

      const controller = new TracyController(
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
      const { TracyController } = await import('../src/ui/TracyController')
      const { logger } = await import('../src/shared/logger')

      const mockView = {
        refresh: vi.fn(),
        error: vi.fn(),
      }

      const controller = new TracyController(
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
      const { TracyController } = await import('../src/ui/TracyController')
      const { logger } = await import('../src/shared/logger')

      const mockView = {
        refresh: vi.fn(),
        error: vi.fn(),
      }

      const controller = new TracyController(
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
      const { TracyController } = await import('../src/ui/TracyController')
      const { logger } = await import('../src/shared/logger')

      const mockView = {
        refresh: vi.fn(),
        error: vi.fn(),
      }

      const controller = new TracyController(
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

  describe('showInfoPanel / handlePanelShow', () => {
    it('shows user-visible feedback when no file has been tracked yet', async () => {
      const { TracyController } = await import('../src/ui/TracyController')
      const { LineState } = await import('../src/ui/TracyStatusBar')

      const mockView = {
        refresh: vi.fn(),
        error: vi.fn(),
      }

      const controller = new TracyController(
        {} as any,
        {} as any,
        mockView as any,
        'repo-url'
      )

      // Fresh controller starts with statusBarState.filePath = null.
      await controller.showInfoPanel()

      // Regression: previously this could no-op because the panel didn't exist yet.
      expect(mockInfoPanelShow).toHaveBeenCalled()
      expect(mockInfoPanelUpdateBlameInfoState).toHaveBeenCalledWith(
        'ERROR',
        'No file has been tracked yet'
      )
      expect(mockView.refresh).toHaveBeenCalledWith(
        LineState.NO_FILE_SELECTED_ERROR
      )
    })
  })
})
