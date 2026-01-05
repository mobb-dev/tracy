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
  readCompletedFileEditBubbles,
  readRowsByLike,
} from './helpers/testDbReader'

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
      workspaceFolders: [],
      getConfiguration: vi.fn(() => ({
        inspect: vi.fn(() => ({
          workspaceValue: undefined,
          globalValue: undefined,
        })),
      })),
    },
    env: {
      appName: 'cursor',
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
    },
  }
})

// Mock Configstore
vi.mock('configstore', () => ({
  default: vi.fn().mockImplementation(() => ({
    get: vi.fn(() => 'test-api-token'),
    set: vi.fn(),
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
const getCompletedFileEditBubblesMock = vi.fn()

// Mock db module - uses test helper to read real data
vi.mock('../src/cursor/db', () => ({
  initDB: () => initDBMock(),
  closeDB: () => closeDBMock(),
  getRowsByLike: (params: { key: string; value?: string; keyOnly?: boolean }) =>
    getRowsByLikeMock(params),
  getCompletedFileEditBubbles: () => getCompletedFileEditBubblesMock(),
}))

beforeEach(() => {
  resetProcessedBubbles()
  initDBMock.mockClear()
  closeDBMock.mockClear()
  getRowsByLikeMock.mockClear()
  getCompletedFileEditBubblesMock.mockClear()
  uploadAiBlameHandlerFromExtensionSpy.mockClear()
})

afterEach(() => {
  cleanupTestDb()
  vi.clearAllMocks()
})

describe('extension tests', () => {
  type TestCase = {
    name: string
    initialDbFile: string
    targetDbFile: string
    minGetCompletedFileEditBubblesCalls: number
    minUploadAiBlameCalls: number
    snapshotCallsToCheck: number
    uploadCallsToSnapshot: number
  }

  const testCases: TestCase[] = [
    {
      name: 'full database scenario without thinking models',
      initialDbFile: 'empty-state.vscdb',
      targetDbFile: 'full-state.vscdb',
      minGetCompletedFileEditBubblesCalls: 2, // 1 startup + 1 poll
      minUploadAiBlameCalls: 1,
      snapshotCallsToCheck: 2,
      uploadCallsToSnapshot: 1,
    },
    {
      name: 'full database scenario with thinking models',
      initialDbFile: 'empty-state.vscdb',
      targetDbFile: 'full-thinking-state.vscdb',
      minGetCompletedFileEditBubblesCalls: 2, // 1 startup + 1 poll
      minUploadAiBlameCalls: 1,
      snapshotCallsToCheck: 2,
      uploadCallsToSnapshot: 1,
    },
  ]

  it.each(testCases)(
    '$name',
    async ({
      initialDbFile,
      targetDbFile,
      minGetCompletedFileEditBubblesCalls,
      minUploadAiBlameCalls,
      snapshotCallsToCheck,
      uploadCallsToSnapshot,
    }) => {
      // Set up initial empty database
      copyDbFile(initialDbFile, 'state.vscdb')

      // Configure mocks to use test helper reading from real .vscdb files
      getCompletedFileEditBubblesMock.mockImplementation(() =>
        Promise.resolve(readCompletedFileEditBubbles())
      )
      getRowsByLikeMock.mockImplementation(
        (params: { key: string; value?: string; keyOnly?: boolean }) =>
          Promise.resolve(readRowsByLike(params))
      )

      const currentPath = __dirname
      activate({
        extensionPath: path.join(currentPath, '..'),
        globalStorageUri: { fsPath: path.join(currentPath, 'files', 'dummy') },
        logPath: '',
        subscriptions: [],
      } as any)

      // Wait for initial startup call
      await vi.waitFor(() => {
        expect(getCompletedFileEditBubblesMock).toHaveBeenCalled()
      })

      // Verify startup call
      expect(getCompletedFileEditBubblesMock).toHaveBeenCalledTimes(1)

      // Get initial return value and snapshot it
      const initialReturnValue =
        await getCompletedFileEditBubblesMock.mock.results[0].value
      expect(initialReturnValue).toMatchSnapshot(
        `${targetDbFile}-getCompletedFileEditBubbles-call`
      )

      // Copy target DB file (simulates new data arriving)
      copyDbFile(targetDbFile, 'state.vscdb')

      // Wait for polling to pick up new data
      await vi.waitFor(
        () => {
          expect(
            getCompletedFileEditBubblesMock.mock.calls.length
          ).toBeGreaterThanOrEqual(minGetCompletedFileEditBubblesCalls)
        },
        { timeout: 10000 }
      )

      // Snapshot polling results
      for (let i = 1; i < snapshotCallsToCheck; i++) {
        const callReturnValue =
          await getCompletedFileEditBubblesMock.mock.results[i].value
        expect(callReturnValue).toMatchSnapshot(
          `${targetDbFile}-getCompletedFileEditBubbles-result-${i}`
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
    }
  )
}, 60000)
