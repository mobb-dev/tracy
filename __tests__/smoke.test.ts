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
    },
    env: {
      appName: 'cursor',
    },
  }
})

//mock the fs readfile() function
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<{
    readFile: typeof import('node:fs/promises').readFile
  }>('node:fs/promises')
  return {
    ...actual,
    readFile: vi.fn((path, options) => {
      //read the relative path to `files/empty-state.vscdb`
      return actual.readFile(`${__dirname}/files/empty-state.vscdb`, options)
    }),
  }
})

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
