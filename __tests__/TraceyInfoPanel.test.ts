import { afterEach, describe, expect, it, vi } from 'vitest'

// Mock env module
vi.mock('../src/env', () => ({
  EXTENSION_NAME: 'mobb-ai-tracer',
}))

// Mock vscode
const mockWebview = {
  html: '',
  onDidReceiveMessage: vi.fn(),
}

const mockWebviewPanel = {
  webview: mockWebview,
  onDidDispose: vi.fn(),
  reveal: vi.fn(),
  dispose: vi.fn(),
}

const mockVSCode = {
  window: {
    createWebviewPanel: vi.fn(() => mockWebviewPanel),
  },
  commands: {
    executeCommand: vi.fn(),
  },
  env: {
    openExternal: vi.fn(),
  },
  Uri: {
    parse: vi.fn(),
  },
  ViewColumn: {
    Beside: 2,
  },
  Disposable: {
    from: vi.fn(() => ({ dispose: vi.fn() })),
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

// Mock webview template
vi.mock('../src/webview/templates/panels/infoPanel', () => ({
  infoPanelTemplate: vi.fn(() => '<html>Mock HTML</html>'),
}))

// Mock crypto module
vi.mock('crypto', () => ({
  randomBytes: vi.fn(() => ({
    toString: vi.fn(() => 'mock-nonce'),
  })),
}))

describe('TraceyInfoPanel', () => {
  afterEach(() => {
    vi.resetAllMocks()
  })

  describe('conversation parsing', () => {
    it('parses valid JSON conversation data', async () => {
      const mockAIBlameCache = {
        getAIBlamePrompt: vi.fn().mockResolvedValue(
          JSON.stringify([
            { type: 'USER_PROMPT', text: 'Hello', date: '2024-01-01' },
            {
              type: 'ASSISTANT_RESPONSE',
              text: 'Hi there',
              date: '2024-01-01',
            },
          ])
        ),
      }

      const mockGetCtx = vi.fn(() => ({
        fileName: 'test.ts',
        lineNumber: 10,
        attribution: { id: 'attr-1' },
        repoUrl: 'https://github.com/user/repo',
      }))

      const { InfoPanel } = await import('../src/ui/TraceyInfoPanel')
      const { infoPanelTemplate } = await import(
        '../src/webview/templates/panels/infoPanel'
      )

      const panel = new InfoPanel(mockAIBlameCache as any, mockGetCtx, vi.fn())

      await panel.show()

      // Should have called template with parsed conversation
      expect(infoPanelTemplate).toHaveBeenCalledWith(
        { nonce: 'mock-nonce' },
        expect.objectContaining({
          conversation: [
            { type: 'USER_PROMPT', text: 'Hello', date: '2024-01-01' },
            {
              type: 'ASSISTANT_RESPONSE',
              text: 'Hi there',
              date: '2024-01-01',
            },
          ],
        })
      )
    })

    it('handles malformed JSON conversation data gracefully', async () => {
      const mockAIBlameCache = {
        getAIBlamePrompt: vi.fn().mockResolvedValue('invalid json {'),
      }

      const mockGetCtx = vi.fn(() => ({
        fileName: 'test.ts',
        lineNumber: 10,
        attribution: { id: 'attr-1' },
        repoUrl: 'https://github.com/user/repo',
      }))

      const { InfoPanel } = await import('../src/ui/TraceyInfoPanel')
      const { logger } = await import('../src/shared/logger')
      const { infoPanelTemplate } = await import(
        '../src/webview/templates/panels/infoPanel'
      )

      const panel = new InfoPanel(mockAIBlameCache as any, mockGetCtx, vi.fn())

      await panel.show()

      // Should log error and use empty conversation
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to parse prompt content:',
        expect.any(Error)
      )

      expect(infoPanelTemplate).toHaveBeenCalledWith(
        { nonce: 'mock-nonce' },
        expect.objectContaining({
          conversation: [],
        })
      )
    })

    it('handles missing attribution gracefully', async () => {
      const mockAIBlameCache = {
        getAIBlamePrompt: vi.fn(),
      }

      const mockGetCtx = vi.fn(() => ({
        fileName: 'test.ts',
        lineNumber: 10,
        attribution: null,
        repoUrl: 'https://github.com/user/repo',
      }))

      const { InfoPanel } = await import('../src/ui/TraceyInfoPanel')

      const panel = new InfoPanel(mockAIBlameCache as any, mockGetCtx, vi.fn())

      await panel.show()

      // Should not call getAIBlamePrompt if no attribution
      expect(mockAIBlameCache.getAIBlamePrompt).not.toHaveBeenCalled()
    })
  })

  describe('webview message handling', () => {
    it('handles openCommitOnGitHub message', async () => {
      const mockAIBlameCache = { getAIBlamePrompt: vi.fn() }
      const mockGetCtx = vi.fn(() => ({
        fileName: 'test.ts',
        lineNumber: 10,
        attribution: { id: 'attr-1' },
        repoUrl: 'https://github.com/user/repo',
      }))

      const { InfoPanel } = await import('../src/ui/TraceyInfoPanel')

      const panel = new InfoPanel(mockAIBlameCache as any, mockGetCtx, vi.fn())
      await panel.show()

      // Get the message handler that was registered
      const messageHandler = mockWebview.onDidReceiveMessage.mock.calls[0][0]

      const testUrl = 'https://github.com/user/repo/commit/abc123'
      await messageHandler({
        command: 'openCommitOnGitHub',
        url: testUrl,
      })

      expect(mockVSCode.env.openExternal).toHaveBeenCalledWith(
        expect.objectContaining({}) // vscode.Uri.parse result
      )
    })

    it('handles continueConversation message', async () => {
      const mockConversation = [
        { type: 'USER_PROMPT', text: 'Hello', date: '2024-01-01' },
        { type: 'ASSISTANT_RESPONSE', text: 'Hi there', date: '2024-01-01' },
      ]

      const mockAIBlameCache = {
        getAIBlamePrompt: vi
          .fn()
          .mockResolvedValue(JSON.stringify(mockConversation)),
      }

      const mockGetCtx = vi.fn(() => ({
        fileName: 'test.ts',
        lineNumber: 10,
        attribution: { id: 'attr-1' },
        repoUrl: 'https://github.com/user/repo',
      }))

      const { InfoPanel } = await import('../src/ui/TraceyInfoPanel')

      const panel = new InfoPanel(mockAIBlameCache as any, mockGetCtx, vi.fn())
      await panel.show()

      const messageHandler = mockWebview.onDidReceiveMessage.mock.calls[0][0]

      await messageHandler({ command: 'continueConversation' })

      expect(mockVSCode.commands.executeCommand).toHaveBeenCalledWith(
        'workbench.action.chat.open',
        expect.objectContaining({
          query: expect.stringContaining('User: Hello'),
        })
      )
    })

    it('handles continueConversation when attribution is missing', async () => {
      const mockAIBlameCache = {
        getAIBlamePrompt: vi.fn(),
      }

      const mockGetCtx = vi.fn(() => ({
        fileName: 'test.ts',
        lineNumber: 10,
        attribution: null, // No attribution
        repoUrl: 'https://github.com/user/repo',
      }))

      const { InfoPanel } = await import('../src/ui/TraceyInfoPanel')

      const panel = new InfoPanel(mockAIBlameCache as any, mockGetCtx, vi.fn())
      await panel.show()

      const messageHandler = mockWebview.onDidReceiveMessage.mock.calls[0][0]

      // Call continueConversation with no attribution - should return early
      await messageHandler({ command: 'continueConversation' })

      // Should not call executeCommand since no attribution
      expect(mockVSCode.commands.executeCommand).not.toHaveBeenCalled()
    })

    it('ignores unknown message commands', async () => {
      const mockAIBlameCache = { getAIBlamePrompt: vi.fn() }
      const mockGetCtx = vi.fn(() => ({
        fileName: 'test.ts',
        lineNumber: 10,
        attribution: null,
      }))

      const { InfoPanel } = await import('../src/ui/TraceyInfoPanel')

      const panel = new InfoPanel(mockAIBlameCache as any, mockGetCtx, vi.fn())
      await panel.show()

      const messageHandler = mockWebview.onDidReceiveMessage.mock.calls[0][0]

      await messageHandler({ command: 'unknownCommand', someData: 'test' })

      // Should not throw or perform any actions
      expect(mockVSCode.commands.executeCommand).not.toHaveBeenCalled()
      expect(mockVSCode.env.openExternal).not.toHaveBeenCalled()
    })
  })

  describe('panel lifecycle', () => {
    it('creates panel on first show', async () => {
      const mockAIBlameCache = { getAIBlamePrompt: vi.fn() }
      const mockGetCtx = vi.fn(() => ({
        fileName: 'test.ts',
        lineNumber: 10,
        attribution: null,
      }))

      const { InfoPanel } = await import('../src/ui/TraceyInfoPanel')

      const panel = new InfoPanel(mockAIBlameCache as any, mockGetCtx, vi.fn())

      await panel.show()

      expect(mockVSCode.window.createWebviewPanel).toHaveBeenCalledWith(
        'mobb-ai-tracer.infoPanel',
        'Tracey AI Information',
        2, // ViewColumn.Beside
        { enableScripts: true, retainContextWhenHidden: true }
      )
    })

    it('reveals existing panel on subsequent show calls', async () => {
      const mockAIBlameCache = { getAIBlamePrompt: vi.fn() }
      const mockGetCtx = vi.fn(() => ({
        fileName: 'test.ts',
        lineNumber: 10,
        attribution: null,
      }))

      const { InfoPanel } = await import('../src/ui/TraceyInfoPanel')

      const panel = new InfoPanel(mockAIBlameCache as any, mockGetCtx, vi.fn())

      await panel.show()
      await panel.show()

      // Should only create panel once
      expect(mockVSCode.window.createWebviewPanel).toHaveBeenCalledTimes(1)
      // Should reveal existing panel
      expect(mockWebviewPanel.reveal).toHaveBeenCalledWith(2, false)
    })

    it('calls onDisposed callback when panel is disposed', async () => {
      const mockAIBlameCache = { getAIBlamePrompt: vi.fn() }
      const mockGetCtx = vi.fn(() => ({
        fileName: 'test.ts',
        lineNumber: 10,
        attribution: null,
      }))
      const onDisposed = vi.fn()

      const { InfoPanel } = await import('../src/ui/TraceyInfoPanel')

      const panel = new InfoPanel(
        mockAIBlameCache as any,
        mockGetCtx,
        onDisposed
      )
      await panel.show()

      // Get the dispose handler that was registered
      const disposeHandler = mockWebviewPanel.onDidDispose.mock.calls[0][0]
      disposeHandler()

      expect(onDisposed).toHaveBeenCalled()
    })
  })
})
