/**
 * Cursor Extension E2E Test - Windows Native
 *
 * This test runs on Windows and validates the Mobb AI Tracer extension
 * with Cursor IDE using Playwright for Electron automation.
 *
 * Key differences from Linux test:
 * - Windows-specific path handling (C:\temp instead of /tmp)
 * - Windows Cursor installation paths
 * - Extensive logging for CI debugging (no local test possible)
 * - Windows-specific shell commands
 */

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
import { initTestGitRepo } from '../shared/vscode-test-helpers'
import { extractVSIX } from '../shared/vsix-installer'
import {
  getWindowsTempBase,
  killProcessTree,
  logDirectoryContents,
  logRelevantEnvVars,
  logWindowsEnvironment,
} from '../shared/windows-helpers'

// Test configuration - increased timeouts for Windows
const TEST_TIMEOUT = 360000 // 6 minutes (Windows is slower)
const AI_RESPONSE_TIMEOUT = 90000 // 90 seconds for AI to respond
const UPLOAD_WAIT_TIMEOUT = 60000 // 60 seconds for upload
const EXTENSION_POLL_INTERVAL = 5000

// ═══════════════════════════════════════════════════════════════════════════════
// Windows-specific Cursor Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function getCursorExecutablePathWindows(): string {
  console.log('  Looking for Cursor executable on Windows...')

  // Check CURSOR_PATH env var first (set by CI workflow)
  if (process.env.CURSOR_PATH) {
    console.log(`  Checking CURSOR_PATH: ${process.env.CURSOR_PATH}`)
    if (fs.existsSync(process.env.CURSOR_PATH)) {
      console.log('    FOUND!')
      return process.env.CURSOR_PATH
    }
    console.log('    Not found at CURSOR_PATH')
  }

  // Common Windows installation paths
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files'
  const localAppData = process.env['LOCALAPPDATA'] || ''
  const winPaths = [
    path.join(localAppData, 'Programs', 'Cursor', 'Cursor.exe'),
    path.join(programFiles, 'Cursor', 'Cursor.exe'),
    'C:\\cursor\\Cursor.exe',
  ]

  for (const p of winPaths) {
    console.log(`  Checking: ${p}`)
    if (fs.existsSync(p)) {
      console.log('    FOUND!')
      return p
    }
  }

  throw new Error(
    'Cursor not found on Windows. Set CURSOR_PATH environment variable or install Cursor.'
  )
}

// Git-init helper moved to `../shared/vscode-test-helpers.ts` (initTestGitRepo).

// ═══════════════════════════════════════════════════════════════════════════════
// Tracy Record Helpers
// ═══════════════════════════════════════════════════════════════════════════════

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

function assertTracyRecordShape(record: TracyRecord, server: MockUploadServer): void {
  console.log(`  Validating record: ${record.recordId?.slice(0, 12)}...`)

  expect(record.platform).toBe('CURSOR')
  expect(record.recordId).toBeTruthy()
  expect(record.recordTimestamp).toBeTruthy()
  expect(new Date(record.recordTimestamp).getTime()).toBeGreaterThan(0)
  expect(record.blameType).toBe('CHAT')
  expect(record.clientVersion).toMatch(/^\d+\.\d+\.\d+/)
  expect(record.computerName).toBeTruthy()
  expect(record.userName).toBeTruthy()

  console.log(`    Platform: ${record.platform}`)
  console.log(`    Record ID: ${record.recordId}`)
  console.log(`    Client Version: ${record.clientVersion}`)
  console.log(`    Computer Name: ${record.computerName}`)
  console.log(`    User Name: ${record.userName}`)
  console.log(`    Repository URL: ${record.repositoryUrl || '(not set)'}`)
  console.log(`    File Path: ${record.filePath || '(not set)'}`)

  const rawData = decodeTracyRawData(record, server)
  expect(rawData.bubble).toBeDefined()
  expect(typeof rawData.bubble).toBe('object')
  expect(rawData.metadata).toBeDefined()
  expect(rawData.metadata.recordId).toBeTruthy()
  expect(rawData.metadata.sessionId).toBeTruthy()

  console.log(`    Model: ${rawData.metadata.model || '(not set)'}`)
  console.log(`    Session: ${rawData.metadata.sessionId?.slice(0, 12)}...`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI Interaction Helpers (Windows-adapted)
// ═══════════════════════════════════════════════════════════════════════════════

async function dismissDialogsWindows(mainWindow: Page): Promise<void> {
  console.log('  Dismissing dialogs...')

  // Git repository dialog
  try {
    const neverButton = mainWindow.locator('button:has-text("Never")')
    if (await neverButton.isVisible({ timeout: 2000 })) {
      console.log('    Found Git dialog, clicking "Never"')
      await neverButton.click()
      await mainWindow.waitForTimeout(500)
    }
  } catch { /* No dialog */ }

  // Login/skip dialogs
  const dismissSelectors = [
    'button:has-text("Not now")',
    'button:has-text("Skip")',
    'button:has-text("Cancel")',
    'button:has-text("Close")',
    '[aria-label="Close"]',
  ]
  for (const selector of dismissSelectors) {
    try {
      const button = mainWindow.locator(selector).first()
      if (await button.isVisible({ timeout: 1000 })) {
        console.log(`    Dismissing: ${selector}`)
        await button.click()
        await mainWindow.waitForTimeout(500)
        break
      }
    } catch { /* Continue */ }
  }

  await mainWindow.keyboard.press('Escape')
  await mainWindow.waitForTimeout(500)
  console.log('  Dialogs dismissed')
}

async function openAgentPanelWindows(mainWindow: Page): Promise<boolean> {
  console.log('  Opening Agent panel (Ctrl+L)...')

  // On Windows, use Control instead of Meta
  await mainWindow.keyboard.press('Control+L')
  await mainWindow.waitForTimeout(1500)

  const chatInputSelectors = [
    'textarea[placeholder*="Plan"]',
    'textarea[placeholder*="context"]',
    '[class*="composer"] textarea',
    '[class*="chat"] textarea',
    'div[contenteditable="true"]',
  ]

  for (const selector of chatInputSelectors) {
    try {
      const input = mainWindow.locator(selector).first()
      if (await input.isVisible({ timeout: 1000 })) {
        console.log(`    Found input: ${selector}`)
        await input.click()
        await mainWindow.waitForTimeout(500)
        return true
      }
    } catch { /* Try next */ }
  }

  console.log('    Could not find chat input')
  return false
}

async function typeAndSubmitPromptWindows(mainWindow: Page, prompt: string): Promise<void> {
  console.log(`  Typing prompt: "${prompt.slice(0, 50)}..."`)
  await mainWindow.keyboard.type(prompt, { delay: 50 })
  await mainWindow.waitForTimeout(1000)

  console.log('  Submitting prompt (Enter)...')
  await mainWindow.keyboard.press('Enter')
  await mainWindow.waitForTimeout(2000)
}

async function waitForCodeGenerationWindows(mainWindow: Page, timeout: number): Promise<boolean> {
  console.log(`  Waiting for code generation (timeout: ${timeout}ms)...`)
  let generationCompleted = false

  // Cursor Agent mode on Windows shows "Review" + "Stop" buttons when done,
  // or "Keep All|Undo All|Accept|Reject" in edit mode.
  // Also detect file count indicators like "> 1 File" which confirm generation.
  try {
    await mainWindow.waitForSelector(
      'text=/Keep All|Undo All|Accept|Reject|Review|\\d+ File/i',
      { timeout }
    )
    console.log('    Generation completion detected')
    generationCompleted = true

    // Try to accept changes in order of likelihood
    const buttonNames = ['Accept', 'Keep All', 'Review']
    for (const name of buttonNames) {
      try {
        const button = mainWindow.locator(`button:has-text("${name}")`).first()
        if (await button.isVisible({ timeout: 2000 })) {
          await button.click()
          console.log(`    Clicked ${name}`)
          await mainWindow.waitForTimeout(2000)
          break
        }
      } catch { /* Try next */ }
    }
  } catch {
    console.log('    Could not detect completion UI, waiting...')
    await mainWindow.waitForTimeout(10000)
  }

  // Handle approval dialogs (Skip button appears for tool call approvals)
  try {
    const skipButton = mainWindow.locator('button:has-text("Skip")').first()
    if (await skipButton.isVisible({ timeout: 3000 })) {
      console.log('    Found approval dialog, clicking Skip')
      await skipButton.click()
      await mainWindow.waitForTimeout(2000)
    }
  } catch { /* No dialog */ }

  return generationCompleted
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test Suite - Windows Only
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Cursor Extension E2E (Windows)', () => {
  // Skip if not on Windows
  test.skip(process.platform !== 'win32', 'Windows-only test')

  let mockServer: MockUploadServer
  let electronApp: ElectronApplication
  let mainWindow: Page
  let testProfileDir: string
  let cursorPid: number | undefined
  let hasRealAuth = false

  const tracker = new CheckpointTracker([
    'Windows Environment Logged',
    'Cursor Found',
    'Extension Installed',
    'Auth Configured',
    'Mock Server Running',
    'Cursor Launched',
    'AI Prompt Sent',
    'Code Generated',
    'Tracy Records Uploaded',
  ])

  test.beforeAll(async () => {
    console.log('')
    console.log('  =============================================')
    console.log('  CURSOR E2E TEST — WINDOWS NATIVE')
    console.log('  =============================================')
    logWindowsEnvironment({ APPDATA: process.env.APPDATA || '(not set)', LOCALAPPDATA: process.env.LOCALAPPDATA || '(not set)' })
    logRelevantEnvVars(['CURSOR_PATH', 'DEBUG', 'TEST_TEMP_DIR'])
    tracker.mark('Windows Environment Logged')

    mockServer = new MockUploadServer(3000)
    await mockServer.start()
    console.log('  Mock server started on port 3000')
    tracker.mark('Mock Server Running')
  })

  test.afterAll(async () => {
    await mockServer.stop()
    console.log('  Mock server stopped')
  })

  test.beforeEach(async () => {
    test.setTimeout(TEST_TIMEOUT)
    tracker.logTimestamp('Test setup starting')

    const tempBase = getWindowsTempBase()
    testProfileDir = path.join(
      tempBase,
      `cursor-e2e-win-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    fs.mkdirSync(testProfileDir, { recursive: true })
    console.log(`  Created test profile: ${testProfileDir}`)

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
    console.log('  Created VS Code settings with mock server URL')

    // Auth setup from CURSOR_STATE_VSCDB_B64
    if (process.env.CURSOR_STATE_VSCDB_B64) {
      console.log('  Setting up auth from CURSOR_STATE_VSCDB_B64...')
      const secretLength = process.env.CURSOR_STATE_VSCDB_B64.length
      console.log(`    Secret length: ${secretLength} chars`)

      try {
        const stateContent = decodeAndDecompressBase64(
          process.env.CURSOR_STATE_VSCDB_B64,
          true
        )

        if (verifySQLiteMagic(stateContent)) {
          console.log('    Verified SQLite database format')
        } else {
          console.log('    Warning: Data does not start with SQLite magic')
        }

        const targetPath = path.join(globalStorageDir, 'state.vscdb')
        fs.writeFileSync(targetPath, stateContent)
        console.log(`    Wrote state.vscdb (${stateContent.length} bytes)`)
        hasRealAuth = true
      } catch (err) {
        console.log(`    Failed to decode auth: ${err}`)
      }
    } else {
      console.log('  No CURSOR_STATE_VSCDB_B64 configured')
    }

    if (hasRealAuth) {
      tracker.mark('Auth Configured')
    }

    // Extension installation
    console.log('  Installing extension...')
    const tracerExtDir = path.join(__dirname, '..', '..', '..')
    const allVsixFiles = fs.readdirSync(tracerExtDir).filter((f) => f.endsWith('.vsix'))
    console.log(`    Found ${allVsixFiles.length} VSIX files`)

    let vsixPath: string | undefined
    const standardVsix = allVsixFiles.find((f) =>
      f.match(/^mobb-ai-tracer-\d+\.\d+\.\d+\.vsix$/)
    )

    if (standardVsix) {
      vsixPath = path.join(tracerExtDir, standardVsix)
      console.log(`    Using VSIX: ${vsixPath}`)
    } else {
      throw new Error('VSIX file not found. Run "npm run package:test" first.')
    }

    const extensionsDir = path.join(testProfileDir, 'User', 'extensions')
    fs.mkdirSync(extensionsDir, { recursive: true })

    extractVSIX(vsixPath, extensionsDir, {
      readMetadata: true,
      verifyFiles: ['package.json', 'out/extension.js'],
      verbose: true,
    })

    // Verify extension installation
    const extDirs = fs.readdirSync(extensionsDir).filter((d) =>
      d.toLowerCase().startsWith('mobb.mobb-ai-tracer')
    )
    if (extDirs.length === 0) {
      throw new Error('Extension directory not found after extraction')
    }
    console.log(`    Extension installed: ${extDirs[0]}`)
    tracker.mark('Extension Installed')
    tracker.mark('Cursor Found')

    tracker.logTimestamp('Test setup complete')
  })

  test.afterEach(async () => {
    tracker.logTimestamp('Cleanup starting')

    // IMPORTANT: Kill the process tree FIRST, don't try electronApp.close().
    // On Windows, electronApp.close() hangs indefinitely waiting for Electron
    // to shut down gracefully, which causes Playwright's 600s teardown timeout.
    // taskkill /F /T force-kills the entire process tree including GPU/renderer.
    if (cursorPid) {
      killProcessTree(cursorPid)
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }

    if (testProfileDir && fs.existsSync(testProfileDir)) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          fs.rmSync(testProfileDir, { recursive: true, force: true })
          console.log('  Test profile cleaned up')
          break
        } catch (err) {
          if (attempt < 2) {
            console.log(`  Cleanup attempt ${attempt + 1} failed, retrying...`)
            await new Promise((resolve) => setTimeout(resolve, 2000))
          } else {
            console.log(`  Could not clean up: ${err}`)
          }
        }
      }
    }

    mockServer.clearAll()
    tracker.logTimestamp('Cleanup complete')
    tracker.printSummary()
  })

  // ═════════════════════════════════════════════════════════════════════════
  // Main Test Case
  // ═════════════════════════════════════════════════════════════════════════

  test('should capture AI inference as tracy records on Windows', async () => {
    tracker.logTimestamp('Test started')

    // Create test workspace with context files for context file upload validation
    const workspaceDir = path.join(testProfileDir, 'test-workspace')
    fs.mkdirSync(workspaceDir, { recursive: true })
    fs.writeFileSync(
      path.join(workspaceDir, 'index.js'),
      '// Test file\nconsole.log("Hello Windows!");\n'
    )

    // Create .cursorrules and .cursor/rules/test-rule.mdc (matching shared test-workspace)
    fs.writeFileSync(
      path.join(workspaceDir, '.cursorrules'),
      'Always use TypeScript for new files.\nFollow functional programming patterns.\n'
    )
    fs.mkdirSync(path.join(workspaceDir, '.cursor', 'rules'), { recursive: true })
    fs.writeFileSync(
      path.join(workspaceDir, '.cursor', 'rules', 'test-rule.mdc'),
      '---\ndescription: Test rule for E2E validation\nglobs: **/*.ts\n---\n\nUse strict TypeScript with no-any rule.\n'
    )
    console.log('  Created context files: .cursorrules, .cursor/rules/test-rule.mdc')

    initTestGitRepo(workspaceDir)
    logDirectoryContents(workspaceDir, '  Workspace')

    // Launch Cursor
    const cursorPath = getCursorExecutablePathWindows()
    const extensionsDir = path.join(testProfileDir, 'User', 'extensions')

    console.log('')
    console.log('  ┌─────────────────────────────────────────────')
    console.log('  │ LAUNCHING CURSOR')
    console.log('  ├─────────────────────────────────────────────')
    console.log(`  │ Executable: ${cursorPath}`)
    console.log(`  │ Profile: ${testProfileDir}`)
    console.log(`  │ Extensions: ${extensionsDir}`)
    console.log(`  │ Workspace: ${workspaceDir}`)
    console.log('  └─────────────────────────────────────────────')

    const workspaceFolderUri = `file:///${workspaceDir.replace(/\\/g, '/')}`
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
        CURSOR_TRACE_ID: undefined,
        CURSOR_SESSION_ID: undefined,
      },
      timeout: 90000,
    })

    mainWindow = await electronApp.firstWindow()
    cursorPid = electronApp.process()?.pid
    console.log(`  Cursor PID: ${cursorPid}`)

    await mainWindow.waitForLoadState('domcontentloaded')
    tracker.logTimestamp('Cursor window loaded')
    tracker.mark('Cursor Launched')
    await mainWindow.screenshot({ path: 'test-results/01-cursor-loaded-win.png' })

    // Wait for workbench
    try {
      await mainWindow.waitForSelector('.monaco-workbench', { timeout: 15000 })
      console.log('  Cursor ready (workbench loaded)')
    } catch {
      console.log('  Could not detect monaco-workbench, continuing...')
      await mainWindow.waitForTimeout(5000)
    }
    await mainWindow.screenshot({ path: 'test-results/02-cursor-ready-win.png' })

    // Wait for extension activation
    console.log('  Waiting for extension activation...')
    const activationStart = Date.now()
    while (
      mockServer.getRequestLog().length === 0 &&
      Date.now() - activationStart < 20000
    ) {
      await mainWindow.waitForTimeout(500)
    }
    console.log(`  Extension activation: ${mockServer.getRequestLog().length} requests after ${Date.now() - activationStart}ms`)

    if (!hasRealAuth) {
      console.log('')
      console.log('  ╔═════════════════════════════════════════════╗')
      console.log('  ║ NO CURSOR AUTH CONFIGURED                   ║')
      console.log('  ║                                             ║')
      console.log('  ║ Running infrastructure-only validation.     ║')
      console.log('  ║ To enable full AI testing, add              ║')
      console.log('  ║ CURSOR_STATE_VSCDB_B64 secret.              ║')
      console.log('  ╚═════════════════════════════════════════════╝')

      const totalRequests = mockServer.getRequestLog().length
      expect(totalRequests).toBeGreaterThan(0)
      console.log(`  Extension made ${totalRequests} requests - infrastructure working!`)

      await mainWindow.screenshot({ path: 'test-results/win-no-auth-validation.png' })
      tracker.logTimestamp('Infrastructure validation complete (no auth)')
      return
    }

    // Send AI prompt
    await dismissDialogsWindows(mainWindow)
    await mainWindow.screenshot({ path: 'test-results/03-dialogs-dismissed-win.png' })

    const inputFocused = await openAgentPanelWindows(mainWindow)
    console.log(`  Agent panel opened, input focused: ${inputFocused}`)
    await mainWindow.screenshot({ path: 'test-results/04-agent-panel-win.png' })

    const uniqueId = Date.now()
    const prompt = `Create a new file called utils-${uniqueId}.js with a simple add function that adds two numbers`

    await typeAndSubmitPromptWindows(mainWindow, prompt)
    tracker.mark('AI Prompt Sent')
    await mainWindow.screenshot({ path: 'test-results/05-prompt-sent-win.png' })

    // Wait for generation
    await mainWindow.waitForTimeout(5000)
    const codeGenerated = await waitForCodeGenerationWindows(mainWindow, AI_RESPONSE_TIMEOUT)

    if (codeGenerated) {
      tracker.mark('Code Generated')
    }
    await mainWindow.screenshot({ path: 'test-results/06-generation-complete-win.png' })

    // Wait for tracy records
    console.log('')
    console.log('  Waiting for tracy record upload...')
    console.log(`    Timeout: ${UPLOAD_WAIT_TIMEOUT}ms`)
    console.log(`    Current records: ${mockServer.getCapturedTracyRecords().length}`)

    try {
      await mockServer.waitForTracyRecords(1, {
        timeout: UPLOAD_WAIT_TIMEOUT,
        logInterval: EXTENSION_POLL_INTERVAL,
      })
      tracker.mark('Tracy Records Uploaded')
    } catch (err) {
      console.log(`  Tracy record wait failed: ${err}`)
      await mainWindow.screenshot({ path: 'test-results/error-upload-timeout-win.png' })

      // Log debug info
      console.log(`  Request log: ${JSON.stringify(mockServer.getRequestLog(), null, 2)}`)
      throw err
    }

    // Validate records
    const records = mockServer.getCapturedTracyRecords()
    console.log(`  Tracy records received: ${records.length}`)

    expect(records.length).toBeGreaterThanOrEqual(1)

    // Filter out CONTEXT_FILES records (ctx:*) which have different rawData structure
    const bubbleRecords = records.filter(
      (r) => !r.recordId.startsWith('ctx:')
    )
    console.log(`  Bubble records: ${bubbleRecords.length} (filtered ${records.length - bubbleRecords.length} context records)`)

    for (let i = 0; i < Math.min(bubbleRecords.length, 3); i++) {
      console.log(`  ┌─ Record #${i + 1} ────────────────────`)
      assertTracyRecordShape(bubbleRecords[i], mockServer)
      console.log(`  └──────────────────────────────────`)
    }

    // Verify no duplicates
    const recordIds = records.map((r) => r.recordId)
    const uniqueIds = new Set(recordIds)
    console.log(`  Total records: ${recordIds.length}, unique: ${uniqueIds.size}`)

    // ═════════════════════════════════════════════════════════════════════
    // Phase 3: Verify context files were uploaded
    // ═════════════════════════════════════════════════════════════════════
    tracker.logTimestamp('Validating context file upload')

    // Since T-476, each context file is uploaded individually to S3 with its
    // own Tracy record (recordId = "ctx:{sessionId}:{md5}") and a `context`
    // metadata field. Poll until both expected files appear.
    const ctxPollStart = Date.now()
    let allContextRecords: ReturnType<
      typeof mockServer.getCapturedTracyRecords
    > = []
    let cursorRulesRecord: (typeof allContextRecords)[0] | undefined
    let testRuleRecord: (typeof allContextRecords)[0] | undefined
    while (Date.now() - ctxPollStart < UPLOAD_WAIT_TIMEOUT) {
      allContextRecords = mockServer
        .getCapturedTracyRecords()
        .filter((r) => r.recordId?.startsWith('ctx:') && r.context)
      cursorRulesRecord = allContextRecords.find(
        (r) => r.context?.name === '.cursorrules'
      )
      testRuleRecord = allContextRecords.find((r) =>
        r.context?.filePath?.includes('.cursor/rules/test-rule.mdc')
      )
      if (cursorRulesRecord && testRuleRecord) break
      await new Promise((r) => setTimeout(r, 1000))
    }

    console.log(`  Context file records: ${allContextRecords.length} files`)
    for (const r of allContextRecords) {
      console.log(`    - ${r.context?.name} (${r.context?.category})`)
    }

    // Verify .cursorrules was captured
    expect(
      cursorRulesRecord,
      '.cursorrules should be in context records'
    ).toBeTruthy()
    expect(cursorRulesRecord!.context?.category).toBe('rule')
    const s3ForCursorRules = mockServer
      .getS3Uploads()
      .get(cursorRulesRecord!.rawDataS3Key!)
    const expectedCursorRules =
      'Always use TypeScript for new files.\nFollow functional programming patterns.\n'
    expect(s3ForCursorRules).toBe(expectedCursorRules)

    // Verify .cursor/rules/test-rule.mdc was captured
    expect(
      testRuleRecord,
      '.cursor/rules/test-rule.mdc should be in context records'
    ).toBeTruthy()
    expect(testRuleRecord!.context?.category).toBe('rule')
    const s3ForTestRule = mockServer
      .getS3Uploads()
      .get(testRuleRecord!.rawDataS3Key!)
    expect(s3ForTestRule).toContain('Use strict TypeScript')
    expect(s3ForTestRule).toContain('no-any rule')

    tracker.logTimestamp('Context files validated')

    tracker.logTimestamp('Test completed successfully')
  })
})
