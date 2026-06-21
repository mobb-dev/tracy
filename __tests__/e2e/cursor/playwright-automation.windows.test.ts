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

import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'

import {
  decodeAndDecompressBase64,
  verifySQLiteMagic,
} from '../shared/compression-utils'
import { launchElectronWithRetry } from '../shared/launch-electron'
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
// 90s = ~4.5x the extension's 20s poll interval on the slowest Windows runners.
// 60s previously gave only ~3 poll cycles of slack and tripped on cold-start GH runners.
const UPLOAD_WAIT_TIMEOUT = 90000
const EXTENSION_POLL_INTERVAL = 5000

/**
 * Debug-only screenshot that never throws. The Windows runner sometimes can't
 * paint Cursor's window fast enough for Playwright's 30s screenshot budget; a
 * failed screenshot would abort the test before any actual assertion ran.
 * Screenshots are diagnostic artifacts, not assertions.
 */
async function safeScreenshot(window: Page, file: string): Promise<void> {
  try {
    await window.screenshot({ path: file, timeout: 10000 })
  } catch (err) {
    console.log(`  (screenshot skipped: ${file} — ${(err as Error).message.split('\n')[0]})`)
  }
}

/**
 * Read the extension's _e2e-activation-trace.jsonl (written when env var
 * MOBB_E2E_ACTIVATION_TRACE=1). Dumps every event to stdout so the CI log
 * tells us exactly where activation stalled / failed.
 *
 * The trace path mirrors `context.globalStorageUri.fsPath` —
 * `{profile}/User/globalStorage/Mobb.mobb-ai-tracer/_e2e-activation-trace.jsonl`.
 */
function dumpActivationTrace(profileDir: string): void {
  // Try the env-var-driven backup path first — it's the source of truth for
  // "did activate() run at all" since it doesn't depend on globalStorageUri.
  const backupPath = path.join(profileDir, '_activation-trace.jsonl')
  const gsPath = path.join(
    profileDir,
    'User',
    'globalStorage',
    'Mobb.mobb-ai-tracer',
    '_e2e-activation-trace.jsonl'
  )
  console.log('')
  console.log('  ┌─ Extension Activation Trace ─────────────────')

  const sources: Array<{ label: string; file: string }> = [
    { label: 'backup (env-var path)', file: backupPath },
    { label: 'globalStorageUri path', file: gsPath },
  ]
  let foundAny = false
  for (const src of sources) {
    if (!fs.existsSync(src.file)) {
      console.log(`  │ [${src.label}] no file at ${src.file}`)
      continue
    }
    foundAny = true
    console.log(`  │ [${src.label}] ${src.file}`)
    try {
      const lines = fs.readFileSync(src.file, 'utf8').trim().split('\n')
      for (const line of lines) {
        console.log(`  │   ${line}`)
      }
    } catch (err) {
      console.log(`  │   (failed to read: ${(err as Error).message})`)
    }
  }
  if (!foundAny) {
    console.log(`  │ → both locations empty: activate() never ran on this Cursor+Windows process`)
  }
  console.log('  └──────────────────────────────────────────────')

  // Also dump anything Cursor logged about extensions — tells us whether
  // Cursor even saw the extension directory and tried to load the manifest.
  dumpCursorExtensionLogs(profileDir)
}

/**
 * Walk Cursor's log directory and dump any line mentioning the extension
 * name. Cursor writes to `{profile}/logs/<timestamp>/exthost*.log` and
 * `main.log` — these surface extension load / activation errors that the
 * test's mock server can't see.
 */
function dumpCursorExtensionLogs(profileDir: string): void {
  const logsRoot = path.join(profileDir, 'logs')
  console.log('')
  console.log('  ┌─ Cursor Logs (extension-related lines) ──────')
  if (!fs.existsSync(logsRoot)) {
    console.log(`  │ (no logs dir at ${logsRoot})`)
    console.log('  └──────────────────────────────────────────────')
    return
  }
  try {
    const sessions = fs.readdirSync(logsRoot).sort()
    let lines = 0
    for (const session of sessions) {
      const sessionDir = path.join(logsRoot, session)
      if (!fs.statSync(sessionDir).isDirectory()) continue
      const files = fs.readdirSync(sessionDir)
      for (const file of files) {
        if (!file.endsWith('.log')) continue
        const filePath = path.join(sessionDir, file)
        const content = fs.readFileSync(filePath, 'utf8')
        // Two passes: targeted (extension-specific) then broad (errors /
        // warnings). The broad pass catches cases where Cursor logs about
        // the extension dir without mentioning our identifier — e.g.
        // "Cannot find manifest", "Skipping extension", "ENOENT".
        const targeted = content
          .split(/\r?\n/)
          .filter((l) =>
            /mobb-ai-tracer|Mobb\.mobb-ai-tracer|onStartupFinished|extension.*activat/i.test(
              l
            )
          )
        const broad = content
          .split(/\r?\n/)
          .filter((l) =>
            /\[error\]|\[warn\]|extensions.json|Failed to|Cannot find|Skipping extension|ENOENT|manifest/i.test(
              l
            )
          )
        const combined = [...targeted, ...broad].slice(0, 30)
        if (combined.length > 0) {
          console.log(`  │ [${session}/${file}]`)
          for (const m of combined) {
            console.log(`  │   ${m}`)
            lines++
            if (lines >= 120) break
          }
          if (lines >= 120) break
        }
      }
      if (lines >= 120) break
    }
    if (lines === 0) {
      console.log('  │ (no extension/error lines in any Cursor log — Cursor may not be scanning extensions dir)')
    }
  } catch (err) {
    console.log(`  │ (failed to read Cursor logs: ${(err as Error).message})`)
  }
  console.log('  └──────────────────────────────────────────────')
}

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

/**
 * Resolve the Cursor CLI wrapper next to `Cursor.exe`. Cursor (like VS
 * Code) ships a `cursor.cmd` shim that sets `ELECTRON_RUN_AS_NODE=1` and
 * exits cleanly after CLI commands. Without the shim, invoking
 * `Cursor.exe --install-extension` on Windows launches the full Electron
 * GUI: the install completes, but the process keeps running (welcome
 * screen, McpProcess retries, etc.) and `execSync` hangs until its
 * timeout fires.
 *
 * Returns the shim path when found, or `null` when neither candidate
 * exists — the caller should then fall back to direct VSIX extraction
 * instead of executing `Cursor.exe` and waiting for it to never exit.
 */
function getCursorCliWrapperPathWindows(exePath: string): string | null {
  const exeDir = path.dirname(exePath)
  // VS Code convention places the shim in two locations; check both.
  const candidates = [
    path.join(exeDir, 'bin', 'cursor.cmd'),
    path.join(exeDir, 'resources', 'app', 'bin', 'cursor.cmd'),
    path.join(exeDir, 'bin', 'cursor'),
    path.join(exeDir, 'resources', 'app', 'bin', 'cursor'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      console.log(`  Found Cursor CLI shim: ${candidate}`)
      return candidate
    }
  }
  console.log(`  Cursor CLI shim not found near ${exeDir}`)
  return null
}

/**
 * Force-kill any stray Cursor.exe processes left over from a previous
 * test attempt. A hung CLI install or crashed Electron app leaves Cursor
 * running, which then holds Cache file locks (EBUSY on `journal.baj`)
 * and the install mutex (`Error: Error mutex already exists`) — both
 * observed on the failing GH Windows runner. Calling this at the top of
 * `beforeEach` makes the test self-healing across Playwright retries.
 *
 * Best-effort: `taskkill` exits non-zero when no matching process
 * exists, which is the normal case on the first attempt. Swallow it.
 */
function killStrayCursorProcessesWindows(): void {
  if (process.platform !== 'win32') return
  try {
    execSync('taskkill /F /IM Cursor.exe /T', {
      // Suppress "not found" stderr so the no-op case stays quiet.
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
    })
    console.log('  Killed stray Cursor.exe processes')
  } catch {
    // No matching process — expected on the first attempt.
  }
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

    // Belt-and-braces against Playwright retries: a previous attempt
    // may have left a Cursor.exe behind holding Cache locks + install
    // mutex. Kill it before we touch anything.
    killStrayCursorProcessesWindows()

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

    // Install via Cursor's own CLI. This lets Cursor manage the
    // `extensions.json` manifest itself, which means the bundled
    // remote-wsl / remote-ssh extensions Cursor installs on first launch
    // *merge* with our entry instead of clobbering it. Diagnostic on
    // commit 645711c94 confirmed the direct-extraction path failed
    // because Cursor's first-launch bundled-extension install wiped any
    // manifest we wrote manually. Running via Cursor's CLI also produces
    // any auxiliary metadata files (`.obsolete`, signatures) the loader
    // checks for.
    //
    // Use the `cursor.cmd` shim — never `Cursor.exe` directly. Direct
    // `Cursor.exe --install-extension` on Windows launches the full
    // Electron GUI (welcome screen, McpProcess startup, etc.) and never
    // exits, so `execSync` hangs until the 5-min timeout fires and the
    // 600s test-suite timeout kills the whole job. The shim sets
    // `ELECTRON_RUN_AS_NODE=1` so the same flags run headless and the
    // process exits when the install completes. If the shim isn't
    // findable next to `Cursor.exe`, skip the CLI path entirely and
    // fall back to direct extraction — running `Cursor.exe` would only
    // re-hang.
    const cursorPathForInstall = getCursorExecutablePathWindows()
    const cursorCliShim = getCursorCliWrapperPathWindows(cursorPathForInstall)
    const cursorInstallEnv = {
      ...process.env,
      MOBB_E2E_ACTIVATION_TRACE: undefined,
      MOBB_E2E_ACTIVATION_TRACE_PATH: undefined,
    }
    if (cursorCliShim) {
      console.log(`  Installing extension via Cursor CLI shim: ${vsixPath}`)
      console.log(`    Using shim: ${cursorCliShim}`)
      try {
        execSync(
          `"${cursorCliShim}" --user-data-dir="${testProfileDir}" --extensions-dir="${extensionsDir}" --install-extension "${vsixPath}" --force`,
          {
            stdio: 'inherit',
            env: cursorInstallEnv,
            // Generous 5-min cap covers Cursor's first-launch init
            // (bundled remote-wsl + remote-ssh) plus our VSIX. With the
            // shim the process exits when done, so this is a true
            // upper bound, not a hang-detector.
            timeout: 300_000,
            // .cmd shims require shell expansion on Windows.
            shell: process.platform === 'win32' ? true : false,
          }
        )
        console.log('  ✅ Extension installed via Cursor CLI shim')
      } catch (err) {
        console.log(
          `  ⚠️ Cursor CLI shim install failed: ${(err as Error).message.split('\n')[0]}`
        )
        console.log('  Falling back to direct extraction...')
        extractVSIX(vsixPath, extensionsDir, {
          readMetadata: true,
          verifyFiles: ['package.json', 'out/extension.js'],
          verbose: true,
        })
      }
    } else {
      console.log('  No Cursor CLI shim available; using direct VSIX extraction')
      extractVSIX(vsixPath, extensionsDir, {
        readMetadata: true,
        verifyFiles: ['package.json', 'out/extension.js'],
        verbose: true,
      })
    }

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
    electronApp = await launchElectronWithRetry({
      executablePath: cursorPath,
      args: [
        `--user-data-dir=${testProfileDir}`,
        `--extensions-dir=${extensionsDir}`,
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        // Suppress first-run UI that can block `onStartupFinished` from
        // firing. Hypothesis: Cursor on Windows sometimes shows a welcome
        // / sign-in / workspace-trust modal that gates extension activation.
        // Without these, the extension's `activate()` may never run, which
        // matches the observed "0 requests" failure mode (confirmed via
        // diagnostic trace in commit 86b8b732c).
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
        '--disable-telemetry',
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
        // Opt-in diagnostic — when set, the extension writes activation
        // events to {globalStorage}/_e2e-activation-trace.jsonl. The test
        // dumps that file on failure so we can see where activation stalled.
        MOBB_E2E_ACTIVATION_TRACE: '1',
        // Also write a backup copy to this absolute path. Distinguishes
        // "activate() never ran" from "globalStorageUri resolved elsewhere".
        MOBB_E2E_ACTIVATION_TRACE_PATH: path.join(
          testProfileDir,
          '_activation-trace.jsonl'
        ),
      },
      timeout: 90000,
    })

    mainWindow = await electronApp.firstWindow()
    cursorPid = electronApp.process()?.pid
    console.log(`  Cursor PID: ${cursorPid}`)

    await mainWindow.waitForLoadState('domcontentloaded')
    tracker.logTimestamp('Cursor window loaded')
    tracker.mark('Cursor Launched')
    await safeScreenshot(mainWindow, 'test-results/01-cursor-loaded-win.png')

    // Wait for workbench
    try {
      await mainWindow.waitForSelector('.monaco-workbench', { timeout: 15000 })
      console.log('  Cursor ready (workbench loaded)')
    } catch {
      console.log('  Could not detect monaco-workbench, continuing...')
      await mainWindow.waitForTimeout(5000)
    }
    await safeScreenshot(mainWindow, 'test-results/02-cursor-ready-win.png')

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

      await safeScreenshot(mainWindow, 'test-results/win-no-auth-validation.png')
      tracker.logTimestamp('Infrastructure validation complete (no auth)')
      return
    }

    // Send AI prompt
    await dismissDialogsWindows(mainWindow)
    await safeScreenshot(mainWindow, 'test-results/03-dialogs-dismissed-win.png')

    const inputFocused = await openAgentPanelWindows(mainWindow)
    console.log(`  Agent panel opened, input focused: ${inputFocused}`)
    await safeScreenshot(mainWindow, 'test-results/04-agent-panel-win.png')

    const uniqueId = Date.now()
    const prompt = `Create a new file called utils-${uniqueId}.js with a simple add function that adds two numbers`

    await typeAndSubmitPromptWindows(mainWindow, prompt)
    tracker.mark('AI Prompt Sent')
    await safeScreenshot(mainWindow, 'test-results/05-prompt-sent-win.png')

    // Wait for generation
    await mainWindow.waitForTimeout(5000)
    const codeGenerated = await waitForCodeGenerationWindows(mainWindow, AI_RESPONSE_TIMEOUT)

    if (codeGenerated) {
      tracker.mark('Code Generated')
    }
    await safeScreenshot(mainWindow, 'test-results/06-generation-complete-win.png')

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
      await safeScreenshot(mainWindow, 'test-results/error-upload-timeout-win.png')

      // Log debug info
      console.log(`  Request log: ${JSON.stringify(mockServer.getRequestLog(), null, 2)}`)

      // Dump the extension's activation trace if MOBB_E2E_ACTIVATION_TRACE
      // was enabled. Tells us *where* activation stalled / failed — the
      // alternative is staring at "0 requests" with no idea why.
      dumpActivationTrace(testProfileDir)

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
