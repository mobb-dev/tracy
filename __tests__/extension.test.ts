import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as db from '../src/cursor/db'
import { resetProcessedBubbles } from '../src/cursor/processor'
import { activate } from '../src/extension'
import * as upload_ai_blame from '../src/mobbdev_src/args/commands/upload_ai_blame'
import * as ts from '../src/shared/startupTimestamp'

vi.mock('vscode', () => {
  return {
    workspace: {
      workspaceFolders: [],
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
      pii: { total: 0, high: 0, medium: 0, low: 0 },
      secrets: 0,
    },
    inferenceCounts: {
      pii: { total: 0, high: 0, medium: 0, low: 0 },
      secrets: 0,
    },
    promptsUUID: 'test-prompts-uuid',
    inferenceUUID: 'test-inference-uuid',
  })

// Spy on getRowsByLike to monitor calls while keeping original implementation
const getRowsByLikeSpy = vi.spyOn(db, 'getRowsByLike')

function copyDbFile(srcName: string, destName: string) {
  const currentPath = __dirname
  const srcPath = path.join(currentPath, 'files', srcName)
  const destPath = path.join(currentPath, 'files', destName)
  fs.copyFileSync(srcPath, destPath)
}

beforeEach(() => {
  resetProcessedBubbles()
  getRowsByLikeSpy.mockClear()
  uploadAiBlameHandlerFromExtensionSpy.mockClear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('extension tests', () => {
  type TestCase = {
    name: string
    initialDbFile: string
    targetDbFile: string
    minGetRowsByLikeCalls: number
    minUploadAiBlameCalls: number
    snapshotCallsToCheck: number
    uploadCallsToSnapshot: number
  }

  const testCases: TestCase[] = [
    {
      name: 'full database scenario without thinking models',
      initialDbFile: 'empty-state.vscdb',
      targetDbFile: 'full-state.vscdb',
      minGetRowsByLikeCalls: 50,
      minUploadAiBlameCalls: 3,
      snapshotCallsToCheck: 50,
      uploadCallsToSnapshot: 3,
    },
    {
      name: 'full database scenario with thinking models',
      initialDbFile: 'empty-state.vscdb',
      targetDbFile: 'full-thinking-state.vscdb',
      minGetRowsByLikeCalls: 20,
      minUploadAiBlameCalls: 1,
      snapshotCallsToCheck: 20,
      uploadCallsToSnapshot: 1,
    },
  ]

  it.each(testCases)(
    '$name',
    async ({
      initialDbFile,
      targetDbFile,
      minGetRowsByLikeCalls,
      minUploadAiBlameCalls,
      snapshotCallsToCheck,
      uploadCallsToSnapshot,
    }) => {
      // Copy the initial DB file based on test case
      copyDbFile(initialDbFile, 'state.vscdb')

      const currentPath = __dirname
      activate({
        //we use dummy here because the internal logic goes back one level
        globalStorageUri: { fsPath: path.join(currentPath, 'files', 'dummy') },
        logPath: '',
        subscriptions: [],
      } as any)

      await vi.waitFor(() => {
        expect(getRowsByLikeSpy).toHaveBeenCalled()
      })

      expect(getRowsByLikeSpy).toHaveBeenCalledTimes(1)
      expect(getRowsByLikeSpy).toHaveBeenCalledWith({
        key: 'bubbleId:%',
        value: undefined,
        keyOnly: true,
      })

      // Get the return value (if the function has completed)
      const returnValue = await getRowsByLikeSpy.mock.results[0].value
      expect(returnValue).toMatchSnapshot(`${targetDbFile}-getRowsByLike-call`)

      // Copy the target DB file based on test case
      copyDbFile(targetDbFile, 'state.vscdb')

      await vi.waitFor(
        () => {
          expect(getRowsByLikeSpy.mock.calls.length).toBeGreaterThanOrEqual(
            minGetRowsByLikeCalls
          )
        },
        { timeout: 10000 }
      )

      // Check snapshots for getRowsByLike calls
      for (let i = 1; i < snapshotCallsToCheck; i++) {
        const callArguments = getRowsByLikeSpy.mock.calls[i]
        expect(callArguments).toMatchSnapshot(
          `${targetDbFile}-getRowsByLike-call-${i}`
        )
        const callReturnValue = await getRowsByLikeSpy.mock.results[i].value
        expect(callReturnValue).toMatchSnapshot(
          `${targetDbFile}-getRowsByLike-result-${i}`
        )
      }

      await vi.waitFor(
        () => {
          expect(
            uploadAiBlameHandlerFromExtensionSpy.mock.calls.length
          ).toBeGreaterThanOrEqual(minUploadAiBlameCalls)
        },
        { timeout: 20000 }
      )

      // Check snapshots for uploadAiBlame calls
      for (let i = 0; i < uploadCallsToSnapshot; i++) {
        const uploadCallArguments =
          uploadAiBlameHandlerFromExtensionSpy.mock.calls[i]
        expect(uploadCallArguments).toMatchSnapshot(
          `${targetDbFile}-uploadAiBlame-call-${i}`
        )
      }
    }
  )
}, 30000)
