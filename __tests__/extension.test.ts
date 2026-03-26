import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Import activate AFTER setting up mocks
import { activate } from '../src/extension'
import {
  cleanupTestDb,
  copyDbFile,
  readComposerDataValue,
  readRecentBubbles,
  readSessionBubbles,
} from './helpers/testDbReader'

/** Small delay to let async activation complete before copying target DB */
const ACTIVATION_SETTLE_MS = 200

// Mock @vscode/sqlite3 BEFORE any imports that use it
vi.mock('@vscode/sqlite3', () => ({
  default: {
    OPEN_READONLY: 1,
    Database: vi.fn(),
  },
}))

vi.mock('vscode', () => {
  return {
    workspace: {
      workspaceFolders: [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test-workspace',
          index: 0,
        },
      ],
      getConfiguration: vi.fn(() => ({
        inspect: vi.fn(() => ({
          workspaceValue: undefined,
          globalValue: undefined,
        })),
      })),
      onDidChangeConfiguration: undefined,
      onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
    },
    env: {
      appName: 'cursor',
    },
    window: {
      createStatusBarItem: vi.fn(() => ({
        show: vi.fn(),
        hide: vi.fn(),
        dispose: vi.fn(),
        text: '',
        tooltip: '',
        command: '',
      })),
      showInformationMessage: vi.fn(),
      onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChangeTextEditorSelection: vi.fn(() => ({ dispose: vi.fn() })),
      activeTextEditor: undefined,
    },
    StatusBarAlignment: {
      Right: 2,
      Left: 1,
    },
    commands: {
      registerCommand: vi.fn(),
      executeCommand: vi.fn(),
    },
    Uri: {
      file: vi.fn((path: string) => ({ fsPath: path })),
      parse: vi.fn((path: string) => ({ fsPath: path })),
    },
    EventEmitter: class {
      fire = vi.fn()
      event = vi.fn()
      dispose = vi.fn()
    },
  }
})

// Human tracking wires VS Code event streams; in these tests we focus on
// database-driven upload behavior, so stub human tracking to a no-op.
vi.mock('../src/human/HumanMonitor', () => ({
  HumanTrackingSession: class {
    readonly name = 'HumanTrackingSession'
    async start(): Promise<void> {
      return
    }
    async stop(): Promise<void> {
      return
    }
  },
}))

vi.mock('../src/shared/logger', () => {
  return {
    initLogger: vi.fn(),
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  }
})

// Mock Configstore (npm package) — needed by AuthManager and other consumers
vi.mock('configstore', () => ({
  default: vi.fn().mockImplementation(() => ({
    get: vi.fn(() => undefined),
    set: vi.fn(),
    delete: vi.fn(),
    all: {},
  })),
}))

// Mock ConfigStoreService directly — the singleton is created at module load time,
// so mocking the npm package alone isn't sufficient to control the configStore export.
// Use vi.hoisted so the object is available when the hoisted vi.mock factory runs.
const { mockConfigStore } = vi.hoisted(() => ({
  mockConfigStore: {
    get: vi.fn(() => undefined),
    set: vi.fn(),
    delete: vi.fn(),
    all: {} as Record<string, unknown>,
  },
}))
vi.mock('../src/mobbdev_src/utils/ConfigStoreService', () => ({
  configStore: mockConfigStore,
}))

// Create a mock GQL client
const createMockGQLClient = () => ({
  uploadTracyRecords: vi.fn(async () => ({
    uploadTracyRecords: { status: 'OK', error: null },
  })),
  getTracyRawDataUploadUrl: vi.fn(async () => ({
    getTracyRawDataUploadUrl: {
      status: 'OK',
      error: null,
      url: 'http://mock-s3-url',
      uploadFieldsJSON: '{}',
      keyPrefix: 'test-prefix/',
    },
  })),
  verifyApiConnection: vi.fn(async () => true),
  validateUserToken: vi.fn(async () => 'test-user'),
})

// Mock getAuthenticatedGQLClient directly
vi.mock('../src/mobbdev_src/commands/handleMobbLogin', () => ({
  getAuthenticatedGQLClient: vi.fn(async () => createMockGQLClient()),
}))

// Mock uploadFile (S3 presigned URL upload)
vi.mock('../src/mobbdev_src/features/analysis/upload-file', () => ({
  uploadFile: vi.fn(async () => undefined),
}))

// Mock GQLClient
vi.mock(
  '../src/mobbdev_src/features/analysis/graphql',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../src/mobbdev_src/features/analysis/graphql')
      >()
    return {
      ...actual,
      GQLClient: vi.fn().mockImplementation(() => createMockGQLClient()),
    }
  }
)

// Mock gqlClientFactory
const mockGQLClient = createMockGQLClient()
vi.mock('../src/shared/gqlClientFactory', () => ({
  createGQLClient: vi.fn(async () => mockGQLClient),
  invalidateOnAuthError: vi.fn(),
  invalidateGQLClient: vi.fn(),
}))

// Mock handleMobbLogin
vi.mock('../src/mobbdev_src/commands', () => ({
  handleMobbLogin: vi.fn(async ({ authManager }) => authManager.getGQLClient()),
}))

// Track mock function calls
const initDBMock = vi.fn().mockResolvedValue(undefined)
const closeDBMock = vi.fn().mockResolvedValue(undefined)
const getRecentBubbleKeysMock = vi.fn()
const prefetchSessionsMock = vi.fn()

// Mock db module - uses test helper to read real data
vi.mock('../src/cursor/db', () => ({
  initDB: () => initDBMock(),
  closeDB: () => closeDBMock(),
  getRecentBubbleKeys: (limit: number) => getRecentBubbleKeysMock(limit),
  prefetchSessions: (
    sessions: { composerId: string; afterTimestamp?: string }[]
  ) => prefetchSessionsMock(sessions),
}))

// Mock repositoryInfo to return valid test data
vi.mock('../src/shared/repositoryInfo', async () => {
  const actual = await vi.importActual<
    typeof import('../src/shared/repositoryInfo')
  >('../src/shared/repositoryInfo')

  const mockRepoInfo = {
    repositories: [
      {
        gitRepoUrl: 'https://github.com/test/repo.git',
        gitRoot: '/test/workspace',
      },
    ],
    userEmail: 'test@example.com',
    organizationId: 'test-org-id',
    appType: 'cursor',
    ideVersion: '0.30.0',
    mobbAppBaseUrl: 'http://localhost:3000',
  }

  return {
    ...actual,
    repoInfo: mockRepoInfo,
    initRepoInfo: vi.fn(async () => {
      return mockRepoInfo
    }),
    getRepositoryInfo: vi.fn(async () => mockRepoInfo),
    getNormalizedRepoUrl: vi
      .fn()
      .mockResolvedValue('https://github.com/test/repo'),
  }
})

// Mock DailyMcpDetection
vi.mock('../src/shared/DailyMcpDetection', () => ({
  dailyMcpDetection: {
    start: vi.fn(),
    stop: vi.fn(),
  },
}))

// Mock MCP detection
vi.mock('../src/mobbdev_src/mcp', () => ({
  detectMCPServers: vi.fn(async () => []),
}))

// Mock config module
vi.mock('../src/shared/config', () => ({
  initConfig: vi.fn(),
  getConfig: vi.fn(() => ({
    apiUrl: 'https://api.mobb.ai/v1/graphql',
    webAppUrl: 'https://app.mobb.ai',
    isDevExtension: false,
    extensionVersion: '0.1.0',
    sanitizeData: false,
  })),
  hasRelevantConfigurationChanged: vi.fn(() => false),
}))

// Mock UI components
vi.mock('../src/ui/AIBlameCache', () => ({
  AIBlameCache: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
  })),
}))

vi.mock('../src/ui/GitBlameCache', () => ({
  GitBlameCache: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
  })),
}))

vi.mock('../src/ui/TracyController', () => ({
  TracyController: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
  })),
}))

vi.mock('../src/ui/TracyStatusBar', () => ({
  StatusBarView: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
  })),
}))

beforeEach(() => {
  initDBMock.mockClear()
  closeDBMock.mockClear()
  getRecentBubbleKeysMock.mockClear()
  prefetchSessionsMock.mockClear()
  mockGQLClient.uploadTracyRecords.mockClear()
  mockConfigStore.get.mockReturnValue(undefined)
  mockConfigStore.set.mockClear()
})

afterEach(() => {
  cleanupTestDb()
  vi.clearAllMocks()
})

describe('extension tests', () => {
  const TEST_TIMEOUT_MS = 120_000

  type TestCase = {
    name: string
    initialDbFile: string
    targetDbFile: string
    minPollCalls: number
    minUploadCalls: number
  }

  const testCases: TestCase[] = [
    {
      name: 'full database scenario without thinking models',
      initialDbFile: 'empty-state.vscdb',
      targetDbFile: 'full-state.vscdb',
      minPollCalls: 1,
      minUploadCalls: 1,
    },
    {
      name: 'full database scenario with thinking models',
      initialDbFile: 'empty-state.vscdb',
      targetDbFile: 'full-thinking-state.vscdb',
      minPollCalls: 1,
      minUploadCalls: 1,
    },
  ]

  it.each(testCases)(
    '$name',
    async ({ initialDbFile, targetDbFile, minPollCalls, minUploadCalls }) => {
      // Set up initial empty database
      copyDbFile(initialDbFile, 'state.vscdb')

      // Configure mocks to use test helper reading from real .vscdb files
      getRecentBubbleKeysMock.mockImplementation(() =>
        Promise.resolve(readRecentBubbles())
      )
      prefetchSessionsMock.mockImplementation(
        (
          sessions: {
            composerId: string
            afterRowId?: number
            incompleteBubbleKeys?: string[]
          }[]
        ) =>
          Promise.resolve(
            sessions.map(({ composerId }) => ({
              composerId,
              bubbles: readSessionBubbles(composerId),
              composerDataValue: readComposerDataValue(composerId),
              revisitedBubbles: [],
            }))
          )
      )

      const currentPath = __dirname
      activate({
        extensionPath: path.join(currentPath, '..'),
        globalStorageUri: { fsPath: path.join(currentPath, 'files', 'dummy') },
        logPath: '',
        subscriptions: [],
      } as any)

      // Let activation settle, then copy target DB (simulates new data arriving)
      await new Promise((r) => globalThis.setTimeout(r, ACTIVATION_SETTLE_MS))
      copyDbFile(targetDbFile, 'state.vscdb')

      // Wait for polling to pick up new data
      await vi.waitFor(
        () => {
          expect(
            getRecentBubbleKeysMock.mock.calls.length
          ).toBeGreaterThanOrEqual(minPollCalls)
        },
        { timeout: 30000 }
      )

      // Wait for upload to be triggered
      await vi.waitFor(
        () => {
          expect(
            mockGQLClient.uploadTracyRecords.mock.calls.length
          ).toBeGreaterThanOrEqual(minUploadCalls)
        },
        { timeout: 20000 }
      )

      // Verify tracy record shape
      const uploadCall = mockGQLClient.uploadTracyRecords.mock.calls[0][0]
      const { records } = uploadCall
      expect(records.length).toBeGreaterThan(0)

      for (const record of records) {
        expect(record.platform).toBe('CURSOR')
        expect(record.recordId).toBeDefined()
        expect(record.recordTimestamp).toBeDefined()
        // Raw records should have rawDataS3Key (uploaded to S3 via presigned URL)
        expect(record.rawDataS3Key).toBeDefined()
      }
    },
    TEST_TIMEOUT_MS
  )
}, 60000)
