import { describe, expect, it, vi } from 'vitest'
import type { ExtensionContext } from 'vscode'

// Import after mocking
import * as mod from '../src/extension'

vi.mock('../src/shared/logger', () => {
  return {
    initLogger: vi.fn(),
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
  }
})

// Create a mock GQL client
const createMockGQLClient = () => ({
  uploadAIBlameInferencesInitRaw: vi.fn(async () => ({
    uploadAIBlameInferencesInit: {
      uploadSessions: [],
    },
  })),
  finalizeAIBlameInferencesUploadRaw: vi.fn(async () => ({
    finalizeAIBlameInferencesUpload: { status: 'OK', error: null },
  })),
  verifyApiConnection: vi.fn(async () => true),
  validateUserToken: vi.fn(async () => 'test-user'),
})

// Mock GQLClient
vi.mock('../src/mobbdev_src/features/analysis/graphql', () => ({
  GQLClient: vi.fn().mockImplementation(() => createMockGQLClient()),
}))

// Mock handleMobbLogin
vi.mock('../src/mobbdev_src/commands', () => ({
  handleMobbLogin: vi.fn(async ({ inGqlClient }) => inGqlClient),
}))

vi.mock('vscode', () => {
  return {
    workspace: {
      workspaceFolders: [],
      onDidChangeTextDocument: () => ({
        dispose() {
          /* empty */
        },
      }),
      onDidCloseTextDocument: () => ({
        dispose() {
          /* empty */
        },
      }),
      onDidChangeConfiguration: () => ({
        dispose() {
          /* empty */
        },
      }),
    },
    window: {
      createStatusBarItem: vi.fn(() => ({
        text: '',
        tooltip: '',
        show: vi.fn(),
        hide: vi.fn(),
        dispose: vi.fn(),
      })),
      showInformationMessage: vi.fn(),
    },
    commands: {
      registerCommand: vi.fn(() => ({
        dispose() {
          /* empty */
        },
      })),
      executeCommand: vi.fn(),
    },
    env: {
      appName: 'cursor',
      clipboard: {
        writeText: vi.fn(),
      },
    },
    StatusBarAlignment: {
      Right: 2,
      Left: 1,
    },
    MarkdownString: vi.fn().mockImplementation((value) => ({
      value: value || '',
      isTrusted: false,
      supportHtml: false,
    })),
  }
})

// Mock the cursor db module (uses @vscode/sqlite3 which won't work in tests)
vi.mock('../src/cursor/db', () => ({
  initDB: vi.fn().mockResolvedValue(undefined),
  closeDB: vi.fn().mockResolvedValue(undefined),
  getRowsByLike: vi.fn().mockResolvedValue([]),
  getCompletedFileEditBubbles: vi.fn().mockResolvedValue([]),
}))

describe('copilot extension module', () => {
  it('exports activate and deactivate functions', () => {
    expect(typeof mod.activate).toBe('function')
    expect(typeof mod.deactivate).toBe('function')
  })

  it('activates with a minimal context', () => {
    const ctx: unknown = {
      extensionPath: `${__dirname}/..`,
      extensionUri: { fsPath: '/tmp/ext' },
      globalStorageUri: { fsPath: '/tmp/store' },
      logPath: '/tmp/logs',
      subscriptions: [],
    }
    mod.activate(ctx as ExtensionContext)
    mod.deactivate()
  })
})
