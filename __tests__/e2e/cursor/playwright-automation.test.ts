import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { _electron as electron } from 'playwright'

import {
  decodeAndDecompressBase64,
  verifySQLiteMagic,
} from '../shared/compression-utils'
import type { TracyRecord } from '../shared/mock-server'
import { MockUploadServer } from '../shared/mock-server'
import { CheckpointTracker } from '../shared/test-utilities'
import { extractVSIX } from '../shared/vsix-installer'
import {
  getCredentialsFromEnv,
  hasCredentialsInEnv,
  loginToCursor,
} from './cursor-login-helper'
import {
  ensureWorkspaceGitRepo,
  getCursorExecutablePath,
  validateExtensionInstallation,
} from './cursor-test-helpers'
import {
  captureExtensionLogs,
  captureExtensionOutput,
  checkForAuthIssues,
  dismissDialogs,
  openAgentPanel,
  typeAndSubmitPrompt,
  waitForCodeGenerationAndAccept,
} from './cursor-ui-helpers'

// Test configuration
const TEST_TIMEOUT = 300000 // 5 minutes (two prompts + upload waits)
const AI_RESPONSE_TIMEOUT = 60000 // 60 seconds for AI to respond
const UPLOAD_WAIT_TIMEOUT = 45000 // 45 seconds for upload (3x poll interval)
const EXTENSION_POLL_INTERVAL = 5000 // Extension polls for changes every 5 seconds

// ═══════════════════════════════════════════════════════════════════════════════
// Tracy Record Assertion Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Retrieve the rawData for a tracy record from the mock S3 store.
 * Raw data is uploaded as plain JSON to S3 via presigned URL.
 * Returns the parsed CursorRawData object: { bubble, metadata }.
 */
function decodeTracyRawData(record: TracyRecord, server: MockUploadServer): {
  bubble: Record<string, unknown>
  metadata: { recordId: string; sessionId: string; model: string }
} {
  expect(record.rawDataS3Key).toBeTruthy()
  const s3Uploads = server.getS3Uploads()
  const s3Content = s3Uploads.get(record.rawDataS3Key!)
  expect(s3Content, `S3 upload not found for key: ${record.rawDataS3Key}`).toBeTruthy()
  return JSON.parse(s3Content!)
}

/**
 * Assert the full structure of a tracy record matches what the server's CursorParser expects.
 * Validates both the outer TracyRecord fields and the inner CursorRawData shape.
 */
function assertTracyRecordShape(record: TracyRecord, server: MockUploadServer): void {
  // Outer record fields
  expect(record.platform).toBe('CURSOR')
  expect(record.recordId).toBeTruthy()
  expect(record.recordTimestamp).toBeTruthy()
  expect(new Date(record.recordTimestamp).getTime()).toBeGreaterThan(0)
  expect(record.blameType).toBe('CHAT')
  expect(record.clientVersion).toMatch(/^\d+\.\d+\.\d+/)
  expect(record.computerName).toBeTruthy()
  expect(record.userName).toBeTruthy()

  // repositoryUrl should be resolved from the workspace
  expect(record.repositoryUrl).toBeTruthy()

  // Inner rawData structure (CursorRawData)
  const rawData = decodeTracyRawData(record, server)

  expect(rawData.bubble).toBeDefined()
  expect(typeof rawData.bubble).toBe('object')
  expect(rawData.bubble.type).toEqual(expect.any(Number))
  expect(rawData.bubble.createdAt).toEqual(expect.any(String))

  expect(rawData.metadata).toBeDefined()
  // recordId is a bare UUID (bubble ID stripped from the SQLite key prefix)
  expect(rawData.metadata.recordId).toBeTruthy()
  expect(rawData.metadata.recordId).not.toContain('bubbleId:')
  expect(rawData.metadata.sessionId).toBeTruthy()
  // model should be resolved from composerData
  expect(rawData.metadata.model).toBeTruthy()
  expect(typeof rawData.metadata.model).toBe('string')
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test Suite
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Cursor Extension E2E with UI Automation', () => {
  let mockServer: MockUploadServer
  let electronApp: ElectronApplication
  let mainWindow: Page
  let testProfileDir: string
  let cursorPid: number | undefined
  let hasRealAuth = false
  const tracker = new CheckpointTracker([
    'Cursor Installed',
    'Extension Installed',
    'Cursor Auth Configured',
    'Mock Server Running',
    'Cursor Launched',
    'AI Prompt Sent',
    'Code Generated',
    'Tracy Records Uploaded',
  ])

  test.beforeAll(async () => {
    mockServer = new MockUploadServer(3000)
    await mockServer.start()
    tracker.mark('Mock Server Running')
  })

  test.afterAll(async () => {
    await mockServer.stop()
    console.log('Mock server stopped')
  })

  test.beforeEach(async () => {
    test.setTimeout(TEST_TIMEOUT)

    const tempBase = process.env.TEST_TEMP_DIR || os.tmpdir()
    testProfileDir = path.join(
      tempBase,
      `cursor-e2e-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    fs.mkdirSync(testProfileDir, { recursive: true })
    console.log(`Created test profile: ${testProfileDir}`)

    const globalStorageDir = path.join(testProfileDir, 'User', 'globalStorage')
    fs.mkdirSync(globalStorageDir, { recursive: true })

    // Create VS Code settings pointing to mock server
    const settingsPath = path.join(testProfileDir, 'User', 'settings.json')
    const testSettings = {
      'mobbAiTracer.apiUrl': 'http://localhost:3000/graphql',
      'mobbAiTracer.webAppUrl': 'http://localhost:5173',
      'mobbAiTracerDev.apiUrl': 'http://localhost:3000/graphql',
      'mobbAiTracerDev.webAppUrl': 'http://localhost:5173',
    }
    fs.writeFileSync(settingsPath, JSON.stringify(testSettings, null, 2))
    console.log(
      'Created VS Code settings with mock server URL (both prod and dev keys)'
    )

    // ── Auth Setup ──────────────────────────────────────────────────────────
    let authSetup = false
    const authFiles = ['state.vscdb', 'storage.json']

    // Option 1: Auth directory from env var
    if (process.env.CURSOR_AUTH_DIR) {
      const authDir = process.env.CURSOR_AUTH_DIR
      for (const authFile of authFiles) {
        const sourcePath = path.join(authDir, authFile)
        const targetPath = path.join(globalStorageDir, authFile)
        if (fs.existsSync(sourcePath)) {
          fs.copyFileSync(sourcePath, targetPath)
          console.log(`Copied auth from CURSOR_AUTH_DIR: ${authFile}`)
          authSetup = true
          hasRealAuth = true
        }
      }
    }

    // Option 2: Base64-encoded state.vscdb from env var (for CI secrets)
    if (!authSetup && process.env.CURSOR_STATE_VSCDB_B64) {
      const secretLength = process.env.CURSOR_STATE_VSCDB_B64.length
      console.log(
        `Found CURSOR_STATE_VSCDB_B64 env var (${secretLength} chars)`
      )

      const stateContent = decodeAndDecompressBase64(
        process.env.CURSOR_STATE_VSCDB_B64,
        true
      )

      if (verifySQLiteMagic(stateContent)) {
        console.log('Verified SQLite database format')
      } else {
        const magicBytes = stateContent.slice(0, 16).toString('utf8')
        console.log(
          `Warning: Data does not start with SQLite magic (got: ${magicBytes.slice(0, 20)})`
        )
      }

      const targetPath = path.join(globalStorageDir, 'state.vscdb')
      fs.writeFileSync(targetPath, stateContent)
      console.log(
        `Wrote state.vscdb (${stateContent.length} bytes) to: ${targetPath}`
      )
      authSetup = true
      hasRealAuth = true
    }

    // Option 2.5: Local cursor-auth.b64 file
    if (!authSetup) {
      const localAuthFile = path.join(__dirname, 'cursor-auth.b64')
      if (fs.existsSync(localAuthFile)) {
        console.log(`Found local auth file: ${localAuthFile}`)
        const base64Content = fs.readFileSync(localAuthFile, 'utf8').trim()
        console.log(`Read ${base64Content.length} chars from cursor-auth.b64`)

        const stateContent = decodeAndDecompressBase64(base64Content, true)

        if (verifySQLiteMagic(stateContent)) {
          console.log('Verified SQLite database format')
        } else {
          const magicBytes = stateContent.slice(0, 16).toString('utf8')
          console.log(
            `Warning: Data does not start with SQLite magic (got: ${magicBytes.slice(0, 20)})`
          )
        }

        const targetPath = path.join(globalStorageDir, 'state.vscdb')
        fs.writeFileSync(targetPath, stateContent)
        console.log(
          `Wrote state.vscdb (${stateContent.length} bytes) from local file`
        )
        authSetup = true
        hasRealAuth = true
      }
    }

    // Option 3: Local Cursor installation (macOS dev only)
    if (!authSetup && process.platform === 'darwin') {
      const userCursorGlobalStorage = path.join(
        process.env.HOME || '',
        'Library/Application Support/Cursor/User/globalStorage'
      )
      for (const authFile of authFiles) {
        const sourcePath = path.join(userCursorGlobalStorage, authFile)
        const targetPath = path.join(globalStorageDir, authFile)
        if (fs.existsSync(sourcePath)) {
          fs.copyFileSync(sourcePath, targetPath)
          console.log(`Copied Cursor auth file: ${authFile}`)
          authSetup = true
          hasRealAuth = true
        }
      }
    }

    // Option 4: Browser-based login
    if (!authSetup && hasCredentialsInEnv()) {
      console.log('Attempting browser-based Cursor login...')
      const credentials = getCredentialsFromEnv()!
      const loginResult = await loginToCursor(credentials, testProfileDir, {
        headless: process.env.CURSOR_LOGIN_HEADLESS !== 'false',
      })

      if (loginResult.success) {
        console.log(`Browser login successful for: ${credentials.email}`)
        authSetup = true
        hasRealAuth = true
      } else {
        console.log(`Browser login failed: ${loginResult.error}`)
        console.log('   Falling back to empty database')
      }
    }

    // Option 5: Empty test database (final fallback)
    if (!authSetup) {
      const emptyDbPath = path.join(
        __dirname,
        '..',
        '..',
        'files',
        'empty-state.vscdb'
      )
      const targetDbPath = path.join(globalStorageDir, 'state.vscdb')
      if (fs.existsSync(emptyDbPath)) {
        fs.copyFileSync(emptyDbPath, targetDbPath)
        console.log('Copied empty test database (no Cursor auth found)')
      } else {
        console.log(
          'Warning: No Cursor auth available - Cursor may prompt for login'
        )
        console.log(
          '   Set CURSOR_AUTH_DIR, CURSOR_STATE_VSCDB_B64, or CURSOR_EMAIL/CURSOR_PASSWORD env vars'
        )
      }
    }

    // ── Extension Installation ──────────────────────────────────────────────
    const tracerExtDir = path.join(__dirname, '..', '..', '..')
    const allVsixFiles = fs
      .readdirSync(tracerExtDir)
      .filter((f) => f.endsWith('.vsix'))

    let vsixPath: string
    const linuxVsix = allVsixFiles.find((f) => f.includes('-linux'))
    const standardVsix = allVsixFiles.find((f) =>
      f.match(/^mobb-ai-tracer-\d+\.\d+\.\d+\.vsix$/)
    )

    if (process.platform === 'linux' && linuxVsix) {
      vsixPath = path.join(tracerExtDir, linuxVsix)
      console.log(`Found Linux-specific VSIX: ${vsixPath}`)
    } else if (standardVsix) {
      vsixPath = path.join(tracerExtDir, standardVsix)
      console.log(`Found VSIX: ${vsixPath}`)
    } else {
      throw new Error(
        'VSIX file not found. Run "npm run package:test" first to create the extension package.'
      )
    }

    console.log('Installing extension via direct extraction...')
    const possibleExtDirs = [
      path.join(testProfileDir, 'User', 'extensions'),
      path.join(testProfileDir, 'extensions'),
    ]
    for (const dir of possibleExtDirs) {
      fs.mkdirSync(dir, { recursive: true })
    }

    const extensionsDir = possibleExtDirs[0]
    extractVSIX(vsixPath, extensionsDir, {
      readMetadata: true,
      verifyFiles: ['package.json', 'out/extension.js'],
      verbose: true,
    })

    await validateExtensionInstallation(testProfileDir, tracker)

    tracker.mark('Cursor Installed')
    if (hasRealAuth) {
      tracker.mark('Cursor Auth Configured')
    }
  })

  test.afterEach(async () => {
    tracker.logTimestamp('Cleanup started (afterEach)')

    if (cursorPid) {
      try {
        process.kill(cursorPid, 'SIGKILL')
        tracker.logTimestamp(`Force killed Cursor (PID: ${cursorPid})`)
      } catch {
        console.log('Cursor already exited')
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    if (testProfileDir && fs.existsSync(testProfileDir)) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          fs.rmSync(testProfileDir, { recursive: true, force: true })
          tracker.logTimestamp('Test profile cleaned up')
          break
        } catch (cleanupError) {
          if (attempt < 2) {
            console.log(
              `Cleanup attempt ${attempt + 1} failed, retrying...`
            )
            await new Promise((resolve) => setTimeout(resolve, 1000))
          } else {
            console.log(`Could not clean up test profile: ${cleanupError}`)
          }
        }
      }
    }

    mockServer.clearAll()
    tracker.logTimestamp('Cleanup complete (afterEach)')
    tracker.printSummary()
  })

  // ═════════════════════════════════════════════════════════════════════════
  // Shared Setup: Launch Cursor, Wait for Extension Activation
  // ═════════════════════════════════════════════════════════════════════════

  async function launchCursorAndWaitForActivation(): Promise<void> {
    const workspaceDir = path.join(__dirname, '..', 'shared', 'test-workspace')
    const extensionsDir = path.join(testProfileDir, 'User', 'extensions')

    ensureWorkspaceGitRepo(workspaceDir)

    const cursorPath = getCursorExecutablePath()
    console.log('Cursor executable:', cursorPath)
    console.log('Extensions directory:', extensionsDir)

    try {
      const installedExts = fs.readdirSync(extensionsDir)
      console.log('Installed extensions:', installedExts)
    } catch (e) {
      console.log(`Could not list extensions: ${e}`)
    }

    console.log('Launching Cursor...')
    const workspaceFolderUri = `file://${workspaceDir}`
    console.log(`Opening workspace folder: ${workspaceFolderUri}`)
    electronApp = await electron.launch({
      executablePath: cursorPath,
      args: [
        `--user-data-dir=${testProfileDir}`,
        `--extensions-dir=${extensionsDir}`,
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        `--folder-uri=${workspaceFolderUri}`,
      ],
      env: {
        ...process.env,
        API_URL: 'http://localhost:3000/graphql',
        MOBB_API_URL: 'http://localhost:3000',
        MOBB_API_TOKEN: 'test-token',
        NODE_ENV: 'test',
        NO_PROXY: 'localhost,127.0.0.1,::1',
        no_proxy: 'localhost,127.0.0.1,::1',
        CLAUDE_DESKTOP: undefined,
        ANTHROPIC_CLAUDE: undefined,
        WINDSURF_IPC_HOOK: undefined,
        WINDSURF_PID: undefined,
        // Do NOT set CURSOR_TRACE_ID or CURSOR_SESSION_ID — real Cursor
        // doesn't set them. Detection must work via vscode.env.appName
        // fallback so the e2e catches regressions like T-443.
        CURSOR_TRACE_ID: undefined,
        CURSOR_SESSION_ID: undefined,
      },
      timeout: 60000,
    })

    mainWindow = await electronApp.firstWindow()
    cursorPid = electronApp.process()?.pid
    console.log(`Cursor PID: ${cursorPid}`)
    await mainWindow.waitForLoadState('domcontentloaded')
    tracker.logTimestamp('Cursor window loaded')
    tracker.mark('Cursor Launched')
    await mainWindow.screenshot({ path: 'test-results/01-cursor-loaded.png' })

    // Wait for workbench
    try {
      await mainWindow.waitForSelector('.monaco-workbench', { timeout: 10000 })
      tracker.logTimestamp('Cursor ready (workbench loaded)')
    } catch {
      console.log('Could not detect monaco-workbench, continuing anyway...')
      await mainWindow.waitForTimeout(3000)
      tracker.logTimestamp('Cursor ready (fallback timeout)')
    }
    await mainWindow.screenshot({ path: 'test-results/02-cursor-ready.png' })

    // Wait for extension activation
    console.log('Waiting for extension to activate...')
    const activationStartTime = Date.now()
    const activationTimeout = 15000
    while (
      mockServer.getRequestLog().length === 0 &&
      Date.now() - activationStartTime < activationTimeout
    ) {
      await mainWindow.waitForTimeout(500)
    }

    tracker.logTimestamp('Extension activation wait complete', {
      mockServerRequests: mockServer.getRequestLog().length,
      waitedMs: Date.now() - activationStartTime,
    })

    // Check for unresponsive extension host
    const unresponsiveAlert = await mainWindow
      .locator('text=/Extension Host Unresponsive/i')
      .count()
    if (unresponsiveAlert > 0) {
      console.log('WARNING: Extension host unresponsive alert detected!')
      await mainWindow.screenshot({
        path: 'test-results/error-extension-host-unresponsive.png',
      })
    } else {
      console.log('Extension activated successfully')
    }

    // Capture extension output
    try {
      await captureExtensionOutput(mainWindow, electronApp)
    } catch (err) {
      console.log(`Could not open Output panel: ${err}`)
    }
  }

  /**
   * Send a prompt to Cursor AI, wait for generation, and accept changes.
   * @param prompt The text to type into the agent panel
   * @param label Optional label for screenshot filenames (e.g. 'p1', 'p2')
   * Returns true if code was generated.
   */
  async function sendPromptAndAccept(
    prompt: string,
    label = ''
  ): Promise<boolean> {
    const prefix = label ? `${label}-` : ''

    await dismissDialogs(mainWindow)
    await mainWindow.screenshot({
      path: `test-results/${prefix}dialogs-dismissed.png`,
    })

    const inputFocused = await openAgentPanel(mainWindow)
    await mainWindow.screenshot({
      path: `test-results/${prefix}agent-panel-opened.png`,
    })

    console.log(`Input focused: ${inputFocused}`)
    await typeAndSubmitPrompt(mainWindow, prompt)
    tracker.logTimestamp('Prompt submitted')
    tracker.mark('AI Prompt Sent')
    await mainWindow.screenshot({
      path: `test-results/${prefix}prompt-sent.png`,
    })

    // Wait for AI to start generating
    await mainWindow.waitForTimeout(5000)

    // Check for auth issues before waiting for generation
    await checkForAuthIssues(mainWindow)

    // Wait for generation and accept
    const codeGenerated = await waitForCodeGenerationAndAccept(
      mainWindow,
      AI_RESPONSE_TIMEOUT
    )

    if (codeGenerated) {
      tracker.mark('Code Generated')
    } else {
      console.log('No code generation detected in UI')
      await mainWindow.screenshot({
        path: `test-results/${prefix}error-no-code-generated.png`,
      })
    }

    // Handle Extension Host Unresponsive
    try {
      const reloadButton = mainWindow
        .locator('button:has-text("Reload Window")')
        .first()
      if (await reloadButton.isVisible({ timeout: 1000 })) {
        console.log(
          'Extension Host Unresponsive detected - may affect upload'
        )
      }
    } catch {
      // No dialog, good
    }

    await mainWindow.screenshot({
      path: `test-results/${prefix}generation-completed.png`,
    })
    tracker.logTimestamp('AI generation completed')

    // Wait for extension polling cycle
    await mainWindow.waitForTimeout(2000)
    return codeGenerated
  }

  /**
   * Wait for tracy records and handle upload failure with debug capture.
   */
  async function waitForTracyRecordsWithDebug(
    count: number
  ): Promise<TracyRecord[]> {
    tracker.logTimestamp('Starting tracy record wait', {
      timeout: UPLOAD_WAIT_TIMEOUT,
      currentRecords: mockServer.getCapturedTracyRecords().length,
      totalRequests: mockServer.getRequestLog().length,
    })

    try {
      await mockServer.waitForTracyRecords(count, {
        timeout: UPLOAD_WAIT_TIMEOUT,
        logInterval: EXTENSION_POLL_INTERVAL,
      })
      tracker.mark('Tracy Records Uploaded')
    } catch (uploadError) {
      tracker.logTimestamp('Tracy record wait FAILED', {
        records: mockServer.getCapturedTracyRecords().length,
        requests: mockServer.getRequestLog().length,
      })
      await mainWindow.screenshot({
        path: 'test-results/error-upload-timeout.png',
      })

      // Capture debug logs
      captureExtensionLogs(testProfileDir)

      const extOutputPath = path.join('test-results', 'extension-output.txt')
      if (fs.existsSync(extOutputPath)) {
        const extOutput = fs.readFileSync(extOutputPath, 'utf8')
        console.log('\nContents of extension-output.txt:')
        console.log('-'.repeat(60))
        console.log(extOutput)
        console.log('-'.repeat(60))
      }

      throw uploadError
    }

    return mockServer.getCapturedTracyRecords()
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Test Cases
  // ═════════════════════════════════════════════════════════════════════════

  test('should capture AI inference as tracy records and handle multi-prompt cursor persistence', async () => {
    tracker.logTimestamp('Test started')

    await launchCursorAndWaitForActivation()

    if (!hasRealAuth) {
      handleNoAuth()
      return
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Phase 1: Send first prompt and verify tracy record shape
    // ═══════════════════════════════════════════════════════════════════════
    const uniqueId = Date.now()
    const prompt1 = `Create a new file called utils-${uniqueId}.js with a simple add function that adds two numbers`
    await sendPromptAndAccept(prompt1, 'p1')

    const firstBatchRecords = await waitForTracyRecordsWithDebug(1)

    expect(firstBatchRecords.length).toBeGreaterThanOrEqual(1)
    tracker.logTimestamp('First batch tracy records received', {
      count: firstBatchRecords.length,
      recordIds: firstBatchRecords.map((r) => r.recordId),
      platforms: firstBatchRecords.map((r) => r.platform),
    })

    // (#1) Assert outer record shape + (#2) deep rawData validation
    for (const record of firstBatchRecords) {
      assertTracyRecordShape(record, mockServer)
    }

    // (#5) Verify clientVersion and system fields
    const firstRecord = firstBatchRecords[0]
    expect(firstRecord.clientVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(firstRecord.computerName).toBeTruthy()
    expect(firstRecord.userName).toBeTruthy()

    // (#3) Verify multi-bubble: records should have mostly unique recordIds.
    // Allow a small number of duplicates from non-deterministic agent responses.
    const firstBatchIds = new Set(firstBatchRecords.map((r) => r.recordId))
    const firstBatchDuplicates = firstBatchRecords.length - firstBatchIds.size
    expect(firstBatchDuplicates).toBeLessThanOrEqual(
      Math.max(2, Math.floor(firstBatchRecords.length * 0.2))
    )

    // Verify all records share the same sessionId (same composer session)
    const firstBatchRawData = firstBatchRecords.map((r) => decodeTracyRawData(r, mockServer))
    const firstBatchSessionIds = new Set(
      firstBatchRawData.map((d) => d.metadata.sessionId)
    )
    expect(firstBatchSessionIds.size).toBe(1)

    tracker.logTimestamp('Phase 1 complete — first batch validated', {
      records: firstBatchRecords.length,
      sessionId: firstBatchRawData[0].metadata.sessionId,
      model: firstBatchRawData[0].metadata.model,
    })

    // ═══════════════════════════════════════════════════════════════════════
    // Phase 2: Send second prompt, verify new records + no duplicates
    // ═══════════════════════════════════════════════════════════════════════
    // Clear mock server to isolate second batch
    const firstBatchCount = firstBatchRecords.length
    mockServer.clearTracyRecords()
    tracker.logTimestamp('Cleared tracy records, sending second prompt')

    const prompt2 = `Create a new file called math-${uniqueId}.js with a multiply function that multiplies two numbers`
    await sendPromptAndAccept(prompt2, 'p2')

    // Wait for second batch of tracy records
    const secondBatchRecords = await waitForTracyRecordsWithDebug(1)

    expect(secondBatchRecords.length).toBeGreaterThanOrEqual(1)
    tracker.logTimestamp('Second batch tracy records received', {
      count: secondBatchRecords.length,
      recordIds: secondBatchRecords.map((r) => r.recordId),
    })

    // Validate shape of second batch
    for (const record of secondBatchRecords) {
      assertTracyRecordShape(record, mockServer)
    }

    // (#4) Cursor persistence: second batch must NOT contain any records
    // from the first batch. The cursor was advanced past them.
    const secondBatchIds = new Set(secondBatchRecords.map((r) => r.recordId))
    for (const id of firstBatchIds) {
      expect(secondBatchIds.has(id)).toBe(false)
    }

    // Second batch should have mostly unique records.
    // Allow a small number of duplicates because Cursor's agent response is
    // non-deterministic — retries, re-renders, or duplicate bubble events can
    // produce the same recordId for different response chunks.
    const secondBatchDuplicates =
      secondBatchRecords.length - secondBatchIds.size
    expect(secondBatchDuplicates).toBeLessThanOrEqual(
      Math.max(2, Math.floor(secondBatchRecords.length * 0.2))
    )

    tracker.logTimestamp(
      'Phase 2 complete — multi-prompt cursor persistence verified',
      {
        firstBatch: firstBatchCount,
        secondBatch: secondBatchRecords.length,
        uniqueIds: secondBatchIds.size,
        duplicatesFound: secondBatchDuplicates,
      }
    )

    // TODO: Phase 3 — Human edit E2E test
    // Typing directly in the editor after AI generation requires navigating
    // away from Cursor's diff view to an editable file. Deferred to a
    // dedicated test case that opens a file explicitly before typing.
  })

  // ═════════════════════════════════════════════════════════════════════════
  // No Auth Handling
  // ═════════════════════════════════════════════════════════════════════════

  function handleNoAuth(): void {
    const isCI = process.env.CI === 'true'

    if (isCI) {
      console.log(
        'CI requires Cursor authentication to test inference uploads!'
      )
      console.log(
        '   Add CURSOR_STATE_VSCDB_B64 secret to GitHub repository settings.'
      )
      console.log('   To generate the secret:')
      console.log('   1. Run locally: npm run e2e:refresh-auth')
      console.log('   2. Copy contents of __tests__/e2e/cursor-auth.b64')
      console.log(
        '   3. Add as secret at: https://github.com/mobb-dev/autofixer/settings/secrets/actions'
      )

      captureExtensionLogs(testProfileDir)

      throw new Error(
        'CI requires CURSOR_STATE_VSCDB_B64 secret to be configured for full inference testing. ' +
          'See logs above for setup instructions.'
      )
    }

    // Local development: infrastructure-only validation
    console.log(
      'No real Cursor auth available - validating extension initialization only'
    )
    console.log(
      '   To test full AI inference upload, set CURSOR_AUTH_DIR or CURSOR_STATE_VSCDB_B64'
    )

    const totalRequests = mockServer.getRequestLog().length
    tracker.logTimestamp('Extension validation (no auth)', {
      totalRequests,
      requestLog: mockServer.getRequestLog(),
    })

    expect(totalRequests).toBeGreaterThan(0)
    console.log(
      `Extension made ${totalRequests} GraphQL requests - infrastructure working!`
    )

    captureExtensionLogs(testProfileDir)

    tracker.logTimestamp(
      'Extension validation passed - infrastructure test complete (local only)',
      { requestCount: totalRequests }
    )
  }
})
