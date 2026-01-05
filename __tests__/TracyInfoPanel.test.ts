import { afterEach, describe, expect, it, vi } from 'vitest'

import { AiBlameInferenceType } from '../src/mobbdev_src/features/analysis/scm/generates/client_generates'

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

describe('TracyInfoPanel', () => {
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

      const { InfoPanel } = await import('../src/ui/TracyInfoPanel')
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

      const { InfoPanel } = await import('../src/ui/TracyInfoPanel')
      const { logger } = await import('../src/shared/logger')
      const { infoPanelTemplate } = await import(
        '../src/webview/templates/panels/infoPanel'
      )

      const panel = new InfoPanel(mockAIBlameCache as any, mockGetCtx, vi.fn())

      await panel.show()

      // Should log error and use empty conversation
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.any(Error),
        }),
        'Failed to parse conversation'
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

      const { InfoPanel } = await import('../src/ui/TracyInfoPanel')

      const panel = new InfoPanel(mockAIBlameCache as any, mockGetCtx, vi.fn())

      await panel.show()

      // Should not call getAIBlamePrompt if no attribution
      expect(mockAIBlameCache.getAIBlamePrompt).not.toHaveBeenCalled()
    })

    it('shows conversation section only for CHAT attribution type', async () => {
      const mockAIBlameCache = {
        getAIBlamePrompt: vi
          .fn()
          .mockResolvedValue(
            JSON.stringify([
              { type: 'USER_PROMPT', text: 'Hello', date: '2024-01-01' },
            ])
          ),
      }

      const mockGetCtx = vi.fn(() => ({
        fileName: 'test.ts',
        lineNumber: 10,
        attribution: {
          id: 'attr-1',
          type: AiBlameInferenceType.Chat,
          model: 'gpt-4',
          aiBlameCommitId: 'commit-1',
          aiBlameInferenceId: 'inference-1',
          filePath: 'test.ts',
          lineNumber: 10,
          toolName: 'ChatGPT',
          commitSha: 'abc123',
        },
        repoUrl: 'https://github.com/user/repo',
      }))

      const { InfoPanel } = await import('../src/ui/TracyInfoPanel')
      const { infoPanelTemplate } = await import(
        '../src/webview/templates/panels/infoPanel'
      )

      const panel = new InfoPanel(mockAIBlameCache as any, mockGetCtx, vi.fn())

      await panel.show()

      // Should call infoPanelTemplate with conversationState and conversation data
      expect(infoPanelTemplate).toHaveBeenCalledWith(
        { nonce: 'mock-nonce' },
        expect.objectContaining({
          conversationState: 'SUCCESS',
          conversation: expect.arrayContaining([
            expect.objectContaining({ type: 'USER_PROMPT', text: 'Hello' }),
          ]),
        })
      )
    })

    it('does not show conversation for non-CHAT attribution types', async () => {
      const mockAIBlameCache = {
        getAIBlamePrompt: vi.fn().mockResolvedValue(null),
      }

      const mockGetCtx = vi.fn(() => ({
        fileName: 'test.ts',
        lineNumber: 10,
        attribution: {
          id: 'attr-1',
          type: AiBlameInferenceType.TabAutocomplete,
          model: 'codex',
          aiBlameCommitId: 'commit-1',
          aiBlameInferenceId: 'inference-1',
          filePath: 'test.ts',
          lineNumber: 10,
          toolName: 'GitHub Copilot',
          commitSha: 'def456',
        },
        repoUrl: 'https://github.com/user/repo',
      }))

      const { InfoPanel } = await import('../src/ui/TracyInfoPanel')
      const { infoPanelTemplate } = await import(
        '../src/webview/templates/panels/infoPanel'
      )

      const panel = new InfoPanel(mockAIBlameCache as any, mockGetCtx, vi.fn())

      await panel.show()

      // Should call getAIBlamePrompt even for non-CHAT types (conversation data is always loaded)
      expect(mockAIBlameCache.getAIBlamePrompt).toHaveBeenCalledWith('attr-1')

      // Should call infoPanelTemplate with empty conversation in error state
      expect(infoPanelTemplate).toHaveBeenCalledWith(
        { nonce: 'mock-nonce' },
        expect.objectContaining({
          conversationState: 'ERROR',
          conversationError: 'No conversation data available',
          conversation: [],
        })
      )
    })
  })

  describe('webview message handling', () => {
    it('handles openCommitOnGitHub message', async () => {
      const mockAIBlameCache = { getAIBlamePrompt: vi.fn() }
      const mockGetCtx = vi.fn(() => ({
        fileName: 'test.ts',
        lineNumber: 10,
        attribution: {
          id: 'attr-1',
          type: AiBlameInferenceType.Chat,
          model: 'gpt-4',
          aiBlameCommitId: 'commit-1',
          aiBlameInferenceId: 'inference-1',
          filePath: 'test.ts',
          lineNumber: 10,
          toolName: 'ChatGPT',
          commitSha: 'abc123',
        },
        repoUrl: 'https://github.com/user/repo',
      }))

      const { InfoPanel } = await import('../src/ui/TracyInfoPanel')

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
        attribution: {
          id: 'attr-1',
          type: AiBlameInferenceType.Chat,
          model: 'gpt-4',
          aiBlameCommitId: 'commit-1',
          aiBlameInferenceId: 'inference-1',
          filePath: 'test.ts',
          lineNumber: 10,
          toolName: 'ChatGPT',
          commitSha: 'abc123',
        },
        repoUrl: 'https://github.com/user/repo',
      }))

      const { InfoPanel } = await import('../src/ui/TracyInfoPanel')

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

      const { InfoPanel } = await import('../src/ui/TracyInfoPanel')

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

      const { InfoPanel } = await import('../src/ui/TracyInfoPanel')

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

      const { InfoPanel } = await import('../src/ui/TracyInfoPanel')

      const panel = new InfoPanel(mockAIBlameCache as any, mockGetCtx, vi.fn())

      await panel.show()

      expect(mockVSCode.window.createWebviewPanel).toHaveBeenCalledWith(
        'mobb-ai-tracer.infoPanel',
        'Tracy AI Information',
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

      const { InfoPanel } = await import('../src/ui/TracyInfoPanel')

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

      const { InfoPanel } = await import('../src/ui/TracyInfoPanel')

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

  describe('attribution type display', () => {
    it('displays correct typeInfo for CHAT attribution', async () => {
      const mockAIBlameCache = {
        getAIBlamePrompt: vi.fn().mockResolvedValue(JSON.stringify([])),
      }

      const mockGetCtx = vi.fn(() => ({
        fileName: 'test.ts',
        lineNumber: 10,
        attribution: {
          id: 'attr-1',
          type: AiBlameInferenceType.Chat,
          model: 'gpt-4',
          aiBlameCommitId: 'commit-1',
          aiBlameInferenceId: 'inference-1',
          filePath: 'test.ts',
          lineNumber: 10,
          toolName: 'ChatGPT',
          commitSha: 'abc123',
        },
        repoUrl: 'https://github.com/user/repo',
      }))

      const { InfoPanel } = await import('../src/ui/TracyInfoPanel')
      const { infoPanelTemplate } = await import(
        '../src/webview/templates/panels/infoPanel'
      )

      const panel = new InfoPanel(mockAIBlameCache as any, mockGetCtx, vi.fn())
      await panel.show()

      // Should call infoPanelTemplate with model name as typeInfo
      expect(infoPanelTemplate).toHaveBeenCalledWith(
        { nonce: 'mock-nonce' },
        expect.objectContaining({
          attribution: expect.objectContaining({
            type: AiBlameInferenceType.Chat,
            model: 'gpt-4',
          }),
        })
      )
    })

    it('displays correct typeInfo for TAB_AUTOCOMPLETE attribution', async () => {
      const mockAIBlameCache = { getAIBlamePrompt: vi.fn() }

      const mockGetCtx = vi.fn(() => ({
        fileName: 'test.ts',
        lineNumber: 10,
        attribution: {
          id: 'attr-1',
          type: AiBlameInferenceType.TabAutocomplete,
          model: 'codex',
          aiBlameCommitId: 'commit-1',
          aiBlameInferenceId: 'inference-1',
          filePath: 'test.ts',
          lineNumber: 10,
          toolName: 'GitHub Copilot',
          commitSha: 'def456',
        },
        repoUrl: 'https://github.com/user/repo',
      }))

      const { InfoPanel } = await import('../src/ui/TracyInfoPanel')
      const { infoPanelTemplate } = await import(
        '../src/webview/templates/panels/infoPanel'
      )

      const panel = new InfoPanel(mockAIBlameCache as any, mockGetCtx, vi.fn())
      await panel.show()

      // Should call infoPanelTemplate with 'AI Code Completion' as typeInfo
      expect(infoPanelTemplate).toHaveBeenCalledWith(
        { nonce: 'mock-nonce' },
        expect.objectContaining({
          attribution: expect.objectContaining({
            type: AiBlameInferenceType.TabAutocomplete,
            toolName: 'GitHub Copilot',
          }),
        })
      )
    })

    it('displays correct typeInfo for HUMAN_EDIT attribution', async () => {
      const mockAIBlameCache = { getAIBlamePrompt: vi.fn() }

      const mockGetCtx = vi.fn(() => ({
        fileName: 'test.ts',
        lineNumber: 10,
        attribution: {
          id: 'attr-1',
          type: AiBlameInferenceType.HumanEdit,
          model: 'human',
          aiBlameCommitId: 'commit-1',
          aiBlameInferenceId: 'inference-1',
          filePath: 'test.ts',
          lineNumber: 10,
          toolName: 'Manual Edit',
          commitSha: 'ghi789',
        },
        repoUrl: 'https://github.com/user/repo',
      }))

      const { InfoPanel } = await import('../src/ui/TracyInfoPanel')
      const { infoPanelTemplate } = await import(
        '../src/webview/templates/panels/infoPanel'
      )

      const panel = new InfoPanel(mockAIBlameCache as any, mockGetCtx, vi.fn())
      await panel.show()

      // Should call infoPanelTemplate with 'Human Edit' as typeInfo
      expect(infoPanelTemplate).toHaveBeenCalledWith(
        { nonce: 'mock-nonce' },
        expect.objectContaining({
          attribution: expect.objectContaining({
            type: AiBlameInferenceType.HumanEdit,
            toolName: 'Manual Edit',
          }),
        })
      )
    })
  })
})
