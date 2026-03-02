import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetProcessedBubbles } from '../src/cursor/processor'
// Import activate AFTER setting up mocks
import { activate } from '../src/extension'
import * as upload_ai_blame from '../src/mobbdev_src/args/commands/upload_ai_blame'
import * as ts from '../src/shared/startupTimestamp'
import {
  cleanupTestDb,
  copyDbFile,
  readBubblesByKeys,
  readCompletedFileEditBubbles,
  readRowsByLike,
} from './helpers/testDbReader'

/** Small delay to let async activation complete before copying target DB */
const ACTIVATION_SETTLE_MS = 200

// Polling interval is set in setupEnv.ts (runs before module imports)

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
      onDidChangeConfiguration: undefined, // Checked in extension.ts line 82
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

// Mock Configstore
vi.mock('configstore', () => ({
  default: vi.fn().mockImplementation(() => ({
    get: vi.fn(() => 'test-api-token'),
    set: vi.fn(),
    delete: vi.fn(),
  })),
}))

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

// Mock getAuthenticatedGQLClient directly (used by extension activation/upload path)
vi.mock('../src/mobbdev_src/commands/handleMobbLogin', () => ({
  getAuthenticatedGQLClient: vi.fn(async () => createMockGQLClient()),
}))

// Mock GQLClient
vi.mock('../src/mobbdev_src/features/analysis/graphql', () => ({
  GQLClient: vi.fn().mockImplementation(() => createMockGQLClient()),
}))

// Mock gqlClientFactory
vi.mock('../src/shared/gqlClientFactory', () => ({
  createGQLClient: vi.fn(async () => createMockGQLClient()),
}))

// Mock handleMobbLogin
vi.mock('../src/mobbdev_src/commands', () => ({
  handleMobbLogin: vi.fn(async ({ inGqlClient }) => inGqlClient),
}))

// Mock the startupTimestamp to a fixed date for testing
vi.spyOn(ts, 'startupTimestamp', 'get').mockReturnValue(
  new Date('2024-01-01T00:00:00Z')
)

// Mock uploadAiBlameHandlerFromExtension to prevent actual implementation from running
const uploadAiBlameHandlerFromExtensionSpy = vi
  .spyOn(upload_ai_blame, 'uploadAiBlameHandlerFromExtension')
  .mockResolvedValue({
    promptsCounts: {
      detections: { total: 0, high: 0, medium: 0, low: 0 },
    },
    inferenceCounts: {
      detections: { total: 0, high: 0, medium: 0, low: 0 },
    },
    promptsUUID: 'test-prompts-uuid',
    inferenceUUID: 'test-inference-uuid',
  })

// Track mock function calls
const initDBMock = vi.fn().mockResolvedValue(undefined)
const closeDBMock = vi.fn().mockResolvedValue(undefined)
const getRowsByLikeMock = vi.fn()
const getCompletedFileEditBubblesSinceMock = vi.fn()
const getBubblesByKeysMock = vi.fn().mockResolvedValue([])

// Mock db module - uses test helper to read real data
vi.mock('../src/cursor/db', () => ({
  initDB: () => initDBMock(),
  closeDB: () => closeDBMock(),
  getRowsByLike: (params: { key: string; value?: string; keyOnly?: boolean }) =>
    getRowsByLikeMock(params),
  getCompletedFileEditBubblesSince: (sinceIso: string, limit: number) =>
    getCompletedFileEditBubblesSinceMock(sinceIso, limit),
  getBubblesByKeys: (keys: string[]) => getBubblesByKeysMock(keys),
}))

// Mock repositoryInfo to return valid test data
vi.mock('../src/shared/repositoryInfo', async () => {
  const actual = await vi.importActual<
    typeof import('../src/shared/repositoryInfo')
  >('../src/shared/repositoryInfo')

  const mockRepoInfo = {
    gitRepoUrl: 'https://github.com/test/repo.git',
    gitRoot: '/test/workspace',
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
      // Set the mocked repoInfo
      return mockRepoInfo
    }),
    getRepositoryInfo: vi.fn(async () => mockRepoInfo),
  }
})

// Mock uploader to prevent auth calls during activation
// Use partial mock to keep uploadCursorChanges real so it calls the spied uploadAiBlameHandlerFromExtension
vi.mock('../src/shared/uploader', async () => {
  const actual = await vi.importActual<typeof import('../src/shared/uploader')>(
    '../src/shared/uploader'
  )
  return {
    ...actual,
    getAuthenticatedForUpload: vi.fn(async () => undefined),
  }
})

// Mock circularLog
vi.mock('../src/shared/circularLog', () => ({
  initCircularLog: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logHeartbeat: vi.fn(),
  logTimed: vi.fn(async (_label: string, fn: () => Promise<unknown>) => fn()),
}))

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
  resetProcessedBubbles()
  initDBMock.mockClear()
  closeDBMock.mockClear()
  getRowsByLikeMock.mockClear()
  getCompletedFileEditBubblesSinceMock.mockClear()
  getBubblesByKeysMock.mockClear()
  uploadAiBlameHandlerFromExtensionSpy.mockClear()
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
    minUploadAiBlameCalls: number
    pollCallsToSnapshot: number
    uploadCallsToSnapshot: number
  }

  const testCases: TestCase[] = [
    {
      name: 'full database scenario without thinking models',
      initialDbFile: 'empty-state.vscdb',
      targetDbFile: 'full-state.vscdb',
      minPollCalls: 1,
      minUploadAiBlameCalls: 1,
      pollCallsToSnapshot: 1,
      uploadCallsToSnapshot: 1,
    },
    {
      name: 'full database scenario with thinking models',
      initialDbFile: 'empty-state.vscdb',
      targetDbFile: 'full-thinking-state.vscdb',
      minPollCalls: 1,
      minUploadAiBlameCalls: 1,
      pollCallsToSnapshot: 1,
      uploadCallsToSnapshot: 1,
    },
  ]

  it.each(testCases)(
    '$name',
    async ({
      initialDbFile,
      targetDbFile,
      minPollCalls,
      minUploadAiBlameCalls,
      pollCallsToSnapshot,
      uploadCallsToSnapshot,
    }) => {
      // Set up initial empty database
      copyDbFile(initialDbFile, 'state.vscdb')

      // Configure mocks to use test helper reading from real .vscdb files
      getCompletedFileEditBubblesSinceMock.mockImplementation(() =>
        Promise.resolve(readCompletedFileEditBubbles())
      )
      getRowsByLikeMock.mockImplementation(
        (params: { key: string; value?: string; keyOnly?: boolean }) =>
          Promise.resolve(readRowsByLike(params))
      )
      getBubblesByKeysMock.mockImplementation((keys: string[]) =>
        Promise.resolve(readBubblesByKeys(keys))
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
            getCompletedFileEditBubblesSinceMock.mock.calls.length
          ).toBeGreaterThanOrEqual(minPollCalls)
        },
        { timeout: 30000 }
      )

      // Snapshot polling results
      for (
        let i = 0;
        i <
        Math.min(
          pollCallsToSnapshot,
          getCompletedFileEditBubblesSinceMock.mock.results.length
        );
        i++
      ) {
        const callReturnValue =
          await getCompletedFileEditBubblesSinceMock.mock.results[i].value
        expect(callReturnValue).toMatchSnapshot(
          `${targetDbFile}-poll-result-${i + 1}`
        )
      }

      // Wait for upload to be triggered
      await vi.waitFor(
        () => {
          expect(
            uploadAiBlameHandlerFromExtensionSpy.mock.calls.length
          ).toBeGreaterThanOrEqual(minUploadAiBlameCalls)
        },
        { timeout: 20000 }
      )

      // Snapshot upload call arguments
      for (let i = 0; i < uploadCallsToSnapshot; i++) {
        const uploadCallArguments =
          uploadAiBlameHandlerFromExtensionSpy.mock.calls[i]
        expect(uploadCallArguments).toMatchSnapshot(
          `${targetDbFile}-uploadAiBlame-call-${i}`
        )
      }
    },
    TEST_TIMEOUT_MS
  )
}, 60000)
