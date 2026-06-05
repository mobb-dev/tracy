/**
 * VS Code Extension E2E Test — Windows Native
 *
 * Runs on Windows and validates the Mobb AI Tracer extension with VS Code +
 * GitHub Copilot using Playwright for Electron automation.
 *
 * Windows-specific differences vs Linux:
 *  - Uses `C:\temp` (getWindowsTempBase) to avoid 8.3 short-path (RUNNER~1) issues
 *  - Kills the process tree via `taskkill /F /T` (SIGKILL doesn't cross the tree)
 *  - Does NOT call electronApp.close() — it hangs indefinitely on Windows
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { _electron as electron } from 'playwright'

import type { TracyRecord } from '../shared/mock-server'
import { MockUploadServer } from '../shared/mock-server'
import {
  MOCK_API_URL_DEFAULT,
  MOCK_MOBB_API_URL_DEFAULT,
  MOCK_SERVER_DEFAULT_PORT,
  MOCK_WEB_APP_URL,
  TEST_MOBB_API_TOKEN,
} from '../shared/test-config'
import { CheckpointTracker } from '../shared/test-utilities'
import {
  decodeCopilotRawData as decodeCopilotRawDataShared,
  dumpExtensionsJson,
  forceEnableCopilotInStateDb,
  initTestGitRepo,
  installExtensionViaCli,
  patchExtensionsJsonRemoveBuiltinFlags,
  resolveVSCodeCliPath,
} from '../shared/vscode-test-helpers'
import {
  assertPortFree,
  getWindowsTempBase,
  killProcessTree,
  logDirectoryContents,
  logRelevantEnvVars,
  logWindowsEnvironment,
} from '../shared/windows-helpers'
import { writeCopilotSetupMarkers } from './helpers/create-vscode-state'
import {
  installAuthTriggerExtension,
  interceptOpenExternal,
  performNativeVSCodeSignIn,
} from './helpers/native-signin'
import { loadCredentialsFromEnv } from './helpers/oauth-config'
import {
  captureExtensionLogs,
  dismissDialogs,
  focusCopilotInput,
  openCopilotChat,
  typeAndSubmitPrompt,
  waitForCopilotGenerationAndAccept,
} from './vscode-ui-helpers'

// Windows runners are slower, and native GitHub sign-in (browser login + email
// device-verification) has variable latency (GitHub occasionally throttles
// repeated CI logins). Budget enough to clear sign-in reliably. TODO: cut this
// back once login is skipped via a captured browser storageState.
const TEST_TIMEOUT = 720000 // 12 minutes
const AI_RESPONSE_TIMEOUT = 120000 // 2 minutes for Copilot to respond
const UPLOAD_WAIT_TIMEOUT = 90000 // 90 seconds for tracy upload
const EXTENSION_POLL_INTERVAL = 5000

// ═══════════════════════════════════════════════════════════════════════════════
// Windows-specific VS Code helpers
// ═══════════════════════════════════════════════════════════════════════════════

function getVSCodeExecutablePathWindows(): string {
  console.log('  Looking for VS Code executable on Windows...')

  if (process.env.VSCODE_PATH) {
    console.log(`  Checking VSCODE_PATH: ${process.env.VSCODE_PATH}`)
    if (fs.existsSync(process.env.VSCODE_PATH)) {
      console.log('    FOUND!')
      return process.env.VSCODE_PATH
    }
    console.log('    Not found at VSCODE_PATH')
  }

  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files'
  const localAppData = process.env['LOCALAPPDATA'] || ''
  const winPaths = [
    path.join(programFiles, 'Microsoft VS Code', 'Code.exe'),
    path.join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    'C:\\vscode\\Code.exe',
  ]

  for (const p of winPaths) {
    console.log(`  Checking: ${p}`)
    if (fs.existsSync(p)) {
      console.log('    FOUND!')
      return p
    }
  }

  throw new Error(
    'VS Code not found on Windows. Set VSCODE_PATH environment variable or install VS Code.'
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tracy Record Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** Wrapper over the shared decoder that upgrades pre-conditions to Playwright
 * `expect()` assertions so a missing S3 upload surfaces in the test report. */
function decodeCopilotRawData(
  record: TracyRecord,
  server: MockUploadServer
): {
  request: { requestId: string; modelId?: string; timestamp?: number }
  metadata: { sessionId: string; workspaceRepos?: unknown }
} {
  expect(record.rawDataS3Key).toBeTruthy()
  expect(
    server.getS3Uploads().get(record.rawDataS3Key!),
    `S3 upload not found for key: ${record.rawDataS3Key}`
  ).toBeTruthy()
  return decodeCopilotRawDataShared(record, server)
}

function assertCopilotRecordShape(
  record: TracyRecord,
  server: MockUploadServer
): void {
  console.log(`  Validating record: ${record.recordId?.slice(0, 12)}...`)

  expect(record.platform).toBe('COPILOT')
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
  console.log(`    Repository URL: ${record.repositoryUrl || '(not set)'}`)

  const rawData = decodeCopilotRawData(record, server)
  expect(rawData.request).toBeDefined()
  expect(rawData.request.requestId).toBeTruthy()
  expect(rawData.metadata).toBeDefined()
  expect(rawData.metadata.sessionId).toBeTruthy()

  console.log(`    Model: ${rawData.request.modelId || '(not set)'}`)
  console.log(`    Session: ${rawData.metadata.sessionId?.slice(0, 12)}...`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test Suite — Windows only
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('VS Code Extension E2E (Windows)', () => {
  test.skip(process.platform !== 'win32', 'Windows-only test')

  let mockServer: MockUploadServer
  let electronApp: ElectronApplication
  let mainWindow: Page
  let testProfileDir: string
  let vscodePid: number | undefined
  let hasRealAuth = false
  // GitHub test-account credentials for VS Code's native sign-in (set in
  // beforeEach; the actual sign-in runs after launch in the test body).
  let deviceFlowCreds: ReturnType<typeof loadCredentialsFromEnv> = null
  // Set when Copilot reports an expired GitHub token so we can downgrade to
  // infrastructure-only cleanly instead of hanging on a tracy-upload timeout.
  let copilotAuthInvalid = false

  const tracker = new CheckpointTracker([
    'Windows Environment Logged',
    'VS Code Found',
    'Copilot Installed',
    'Extension Installed',
    'Auth Configured',
    'Mock Server Running',
    'VS Code Launched',
    'Extension Authenticated',
    'AI Prompt Sent',
    'Code Generated',
    'Tracy Records Uploaded',
    'Context Files Uploaded',
  ])

  test.beforeAll(async () => {
    console.log('')
    console.log('  =============================================')
    console.log('  VS CODE E2E TEST — WINDOWS NATIVE')
    console.log('  =============================================')
    logWindowsEnvironment({
      APPDATA: process.env.APPDATA || '(not set)',
      LOCALAPPDATA: process.env.LOCALAPPDATA || '(not set)',
    })
    logRelevantEnvVars(['VSCODE_PATH', 'DEBUG', 'TEST_TEMP_DIR'])
    tracker.mark('Windows Environment Logged')

    await assertPortFree(MOCK_SERVER_DEFAULT_PORT)
    mockServer = new MockUploadServer(MOCK_SERVER_DEFAULT_PORT)
    await mockServer.start()
    console.log(`  Mock server started on port ${MOCK_SERVER_DEFAULT_PORT}`)
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
      `vscode-e2e-win-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    fs.mkdirSync(testProfileDir, { recursive: true })
    console.log(`  Created test profile: ${testProfileDir}`)

    const globalStorageDir = path.join(testProfileDir, 'User', 'globalStorage')
    fs.mkdirSync(globalStorageDir, { recursive: true })

    // Create VS Code settings pointing to mock server
    const settingsPath = path.join(testProfileDir, 'User', 'settings.json')
    const testSettings = {
      'mobbAiTracer.apiUrl': MOCK_API_URL_DEFAULT,
      'mobbAiTracer.webAppUrl': MOCK_WEB_APP_URL,
      'mobbAiTracerDev.apiUrl': MOCK_API_URL_DEFAULT,
      'mobbAiTracerDev.webAppUrl': MOCK_WEB_APP_URL,
      'github.copilot.enable': {
        '*': true,
        plaintext: true,
        markdown: true,
        scminput: false,
      },
      'security.workspace.trust.enabled': false,
      'security.workspace.trust.startupPrompt': 'never',
      'security.workspace.trust.banner': 'never',
      'security.workspace.trust.emptyWindow': true,
      'chat.editing.autoAcceptDelay': 500,
      'chat.editing.confirmEditRequestRemoval': false,
      'chat.editing.confirmEditRequestRetry': false,
      'github.copilot.chat.edits.allowFilesOutsideWorkspace': true,
      'chat.tools.global.autoApprove': true,
      'chat.tools.terminal.autoApprove': true,
      // Force classic "Ask" chat instead of Copilot 0.51's default AGENT mode.
      // A fresh free-tier (free_limited_copilot) sign-in stalls in agent mode
      // ("Reasoning"/"Considering" forever) and never returns a completion, so
      // no Copilot inference is captured. Ask mode produces a normal chat
      // response that the tracer captures. Disabling agent leaves Ask as default.
      'chat.agent.enabled': false,
      // VS Code 1.103+ disables side-loaded extensions that lack signatures.
      'extensions.verifySignature': false,
      'extensions.autoUpdate': false,
      'extensions.autoCheckUpdates': false,
    }
    fs.writeFileSync(settingsPath, JSON.stringify(testSettings, null, 2))
    console.log('  Created VS Code settings with mock server URL')

    // Windows auth strategy: NATIVE sign-in (driven after launch in the test
    // body), NOT state.vscdb injection. On Windows, VS Code's secret store is
    // encrypted with a machine/installation-bound key (Chromium os_crypt
    // AES-256-GCM, key DPAPI-wrapped in `Local State`; `--password-store=basic`
    // is a no-op on Windows), so a session synthesized off-box can never be
    // decrypted → `secrets.get` returns empty → "Got 0 sessions". Instead we let
    // VS Code perform its own GitHub sign-in (loopback OAuth) so it encrypts and
    // stores the session with a key it can read back. The browser half reuses
    // the GitHub login + email device-verification automation; the test-only
    // auth-trigger extension (installed below) requests the session. See
    // helpers/native-signin.ts.
    deviceFlowCreds = loadCredentialsFromEnv()
    if (deviceFlowCreds) {
      console.log(
        '  Native VS Code sign-in will run after launch (creds present)'
      )
    } else {
      console.log(
        '  No sign-in creds (PLAYWRIGHT_GH_CLOUD_USER_EMAIL/PASSWORD) — ' +
          'Copilot checkpoints will fail fast'
      )
    }

    // Extension installation
    console.log('  Installing Mobb extension...')
    const tracerExtDir = path.join(__dirname, '..', '..', '..')
    const allVsixFiles = fs
      .readdirSync(tracerExtDir)
      .filter((f) => f.endsWith('.vsix'))
    console.log(`    Found ${allVsixFiles.length} VSIX files`)

    const devVsix = allVsixFiles.find((f) => f.includes('-dev'))
    const standardVsix = allVsixFiles.find((f) =>
      f.match(/^mobb-ai-tracer-\d+\.\d+\.\d+\.vsix$/)
    )

    let vsixPath: string
    if (devVsix) {
      vsixPath = path.join(tracerExtDir, devVsix)
      console.log(`    Using dev VSIX: ${vsixPath}`)
    } else if (standardVsix) {
      vsixPath = path.join(tracerExtDir, standardVsix)
      console.log(`    Using standard VSIX: ${vsixPath}`)
    } else {
      throw new Error('VSIX file not found. Run "npm run package:test" first.')
    }

    const extensionsDir = path.join(testProfileDir, 'User', 'extensions')
    fs.mkdirSync(extensionsDir, { recursive: true })

    const cliPath = resolveVSCodeCliPath(getVSCodeExecutablePathWindows())

    // ATTEMPT 1: gallery-ID install for Copilot (exercises different code path)
    for (const id of ['GitHub.copilot-chat', 'GitHub.copilot']) {
      installExtensionViaCli(cliPath, id, testProfileDir, extensionsDir)
    }

    // ATTEMPT 2: Mobb + VSIX fallback for Copilot
    const allVsixToInstall: string[] = [vsixPath]
    const vsixDir = process.env.COPILOT_VSIX_DIR
    if (vsixDir && fs.existsSync(vsixDir)) {
      const copilotVsixFiles = fs
        .readdirSync(vsixDir)
        .filter((f) => f.toLowerCase().endsWith('.vsix'))
        .map((f) => path.join(vsixDir, f))
      allVsixToInstall.push(...copilotVsixFiles)
    } else {
      console.log(
        '    COPILOT_VSIX_DIR unset — Copilot Chat will not be available'
      )
    }

    for (const vsix of allVsixToInstall) {
      installExtensionViaCli(cliPath, vsix, testProfileDir, extensionsDir)
    }

    // ATTEMPT 3: patch extensions.json to strip isBuiltin/isApplicationScoped
    dumpExtensionsJson(extensionsDir, 'after-install')
    patchExtensionsJsonRemoveBuiltinFlags(extensionsDir)
    dumpExtensionsJson(extensionsDir, 'after-patch')

    // ATTEMPT 4: force-enable Copilot via state.vscdb
    forceEnableCopilotInStateDb(
      path.join(globalStorageDir, 'state.vscdb')
    )

    // Copilot first-use setup markers. A fresh native sign-in (unlike a
    // pre-onboarded captured session) otherwise lands on the Copilot setup gate,
    // which lets chat scaffolding run but suppresses real completions.
    if (deviceFlowCreds) {
      writeCopilotSetupMarkers(path.join(globalStorageDir, 'state.vscdb'))
    }

    // Install the test-only auth-trigger extension — it requests a GitHub
    // session on startup so the harness can drive VS Code's native sign-in.
    if (deviceFlowCreds) {
      installAuthTriggerExtension(extensionsDir)
      console.log('    Installed auth-trigger extension for native sign-in')
    }

    const extDirs = fs.readdirSync(extensionsDir)
    const mobbExt = extDirs.find((d) =>
      d.toLowerCase().startsWith('mobb.mobb-ai-tracer')
    )
    const copilotExt = extDirs.find((d) => d.startsWith('github.copilot-'))
    if (!mobbExt) {
      throw new Error('Mobb extension directory not found after extraction')
    }
    console.log(`    Extension installed: ${mobbExt}`)
    tracker.mark('Extension Installed')
    if (copilotExt) {
      console.log(`    Copilot extension present: ${copilotExt}`)
      tracker.mark('Copilot Installed')
    } else {
      console.log('    WARNING: no Copilot extension found in extensions dir')
    }
    tracker.mark('VS Code Found')

    tracker.logTimestamp('Test setup complete')
  })

  test.afterEach(async () => {
    tracker.logTimestamp('Cleanup starting')

    // Kill process tree first — electronApp.close() hangs on Windows.
    if (vscodePid) {
      killProcessTree(vscodePid)
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }

    // Capture VS Code's exthost log + the Mobb extension's pino log BEFORE
    // the profile dir is removed below — otherwise an early failure (e.g.
    // activation timeout) leaves no diagnostic trace in the artifact.
    if (testProfileDir && fs.existsSync(testProfileDir)) {
      captureExtensionLogs(testProfileDir)
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

  test('should capture Copilot inference as tracy records on Windows', async () => {
    tracker.logTimestamp('Test started')

    // Create test workspace with context files for CHECKPOINT 8
    const workspaceDir = path.join(testProfileDir, 'test-workspace')
    fs.mkdirSync(workspaceDir, { recursive: true })
    fs.writeFileSync(
      path.join(workspaceDir, 'index.js'),
      '// Test file\nconsole.log("Hello Windows!");\n'
    )
    // Copilot's context-file scanner reads .github/copilot-instructions.md
    fs.mkdirSync(path.join(workspaceDir, '.github'), { recursive: true })
    fs.writeFileSync(
      path.join(workspaceDir, '.github', 'copilot-instructions.md'),
      'Always use TypeScript for new files.\nFollow functional programming patterns.\n'
    )
    // Also ship .cursorrules for completeness (Cursor tests reuse the workspace)
    fs.writeFileSync(
      path.join(workspaceDir, '.cursorrules'),
      'Always use TypeScript for new files.\nFollow functional programming patterns.\n'
    )
    fs.mkdirSync(path.join(workspaceDir, '.cursor', 'rules'), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(workspaceDir, '.cursor', 'rules', 'test-rule.mdc'),
      '---\ndescription: Test rule for E2E validation\nglobs: **/*.ts\n---\n\nUse strict TypeScript with no-any rule.\n'
    )
    console.log('  Created context files: .github/copilot-instructions.md, .cursorrules, .cursor/rules/test-rule.mdc')

    initTestGitRepo(workspaceDir)
    logDirectoryContents(workspaceDir, '  Workspace')

    const vscodePath = getVSCodeExecutablePathWindows()
    const extensionsDir = path.join(testProfileDir, 'User', 'extensions')

    console.log('')
    console.log('  ┌─────────────────────────────────────────────')
    console.log('  │ LAUNCHING VS CODE')
    console.log('  ├─────────────────────────────────────────────')
    console.log(`  │ Executable: ${vscodePath}`)
    console.log(`  │ Profile: ${testProfileDir}`)
    console.log(`  │ Extensions: ${extensionsDir}`)
    console.log(`  │ Workspace: ${workspaceDir}`)
    console.log('  └─────────────────────────────────────────────')

    const workspaceFolderUri = `file:///${workspaceDir.replace(/\\/g, '/')}`
    electronApp = await electron.launch({
      executablePath: vscodePath,
      args: [
        `--user-data-dir=${testProfileDir}`,
        `--extensions-dir=${extensionsDir}`,
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--password-store=basic',
        // Copilot + Copilot Chat declare proposed API usage — pass the
        // flag as a space-separated pair so the Electron main process
        // parses it identically to `code --enable-proposed-api ...`.
        '--enable-proposed-api',
        'GitHub.copilot',
        '--enable-proposed-api',
        'GitHub.copilot-chat',
        '--disable-telemetry',
        `--folder-uri=${workspaceFolderUri}`,
      ],
      env: {
        ...process.env,
        API_URL: MOCK_API_URL_DEFAULT,
        MOBB_API_URL: MOCK_MOBB_API_URL_DEFAULT,
        MOBB_API_TOKEN: TEST_MOBB_API_TOKEN,
        NODE_ENV: 'test',
        NO_PROXY: 'localhost,127.0.0.1,::1',
        no_proxy: 'localhost,127.0.0.1,::1',
      },
      timeout: 90000,
    })

    mainWindow = await electronApp.firstWindow()
    vscodePid = electronApp.process()?.pid
    console.log(`  VS Code PID: ${vscodePid}`)

    copilotAuthInvalid = false
    mainWindow.on('console', (msg) => {
      const text = msg.text()
      if (
        text.includes('Your GitHub token is invalid') ||
        text.includes('sign out from your GitHub account')
      ) {
        copilotAuthInvalid = true
      }
    })

    await mainWindow.waitForLoadState('domcontentloaded')
    tracker.logTimestamp('VS Code window loaded')
    tracker.mark('VS Code Launched')

    // Install the openExternal interceptor NOW (before the auth-trigger
    // extension fires its sign-in request ~8s into startup), so VS Code's
    // loopback OAuth URL is captured rather than handed to the OS browser.
    if (deviceFlowCreds) {
      await interceptOpenExternal(electronApp)
      console.log('  openExternal interceptor installed')
    }
    await mainWindow.screenshot({ path: 'test-results/vs-01-loaded-win.png' })

    try {
      await mainWindow.waitForSelector('.monaco-workbench', { timeout: 15000 })
      console.log('  VS Code workbench ready')
    } catch {
      console.log('  Could not detect monaco-workbench, continuing...')
      await mainWindow.waitForTimeout(5000)
    }
    await mainWindow.screenshot({
      path: 'test-results/vs-02-workbench-ready-win.png',
    })

    // Wait for extension activation
    console.log('  Waiting for extension activation...')
    const activationStart = Date.now()
    let lastLoggedCount = 0
    while (
      mockServer.getRequestLog().length === 0 &&
      Date.now() - activationStart < 30000
    ) {
      await mainWindow.waitForTimeout(500)
      const elapsed = Date.now() - activationStart
      const current = mockServer.getRequestLog()
      // Log on every 5s tick OR when a new request lands. Helps distinguish
      // "extension never started" from "started but slow" in CI — a bare
      // count can't show whether 'verifyApiConnection' or 'Me' actually fired.
      if (current.length !== lastLoggedCount || elapsed % 5000 < 500) {
        const ops = current
          .map((r) => r.body?.operationName)
          .filter(Boolean)
          .join(', ')
        console.log(
          `  ... ${Math.floor(elapsed / 1000)}s elapsed, requests: ${current.length}${ops ? ` [${ops}]` : ''}`
        )
        lastLoggedCount = current.length
      }
    }

    const requests = mockServer.getRequestLog()
    const finalOps = requests
      .map((r) => r.body?.operationName)
      .filter(Boolean)
      .join(', ')
    console.log(
      `  Extension activation: ${requests.length} requests after ${Date.now() - activationStart}ms${finalOps ? ` [${finalOps}]` : ''}`
    )
    expect(
      requests.length,
      'Extension made no GraphQL requests — activation failed'
    ).toBeGreaterThan(0)
    tracker.mark('Extension Authenticated')
    await mainWindow.screenshot({
      path: 'test-results/vs-03-extension-activated-win.png',
    })

    // ═══════════════════════════════════════════════════════════════════════
    // Native GitHub sign-in for Copilot. VS Code performs the loopback OAuth
    // itself (so it stores the session with its own readable key); we capture
    // the URL it opens and drive the browser through GitHub login + authorize.
    // ═══════════════════════════════════════════════════════════════════════
    if (deviceFlowCreds) {
      console.log('  Performing native VS Code GitHub sign-in for Copilot...')
      const signInResult = await performNativeVSCodeSignIn(
        electronApp,
        mainWindow,
        deviceFlowCreds,
        { headless: true }
      )
      if (signInResult.success) {
        hasRealAuth = true
        tracker.mark('Auth Configured')
        console.log('    Native sign-in completed')
      } else {
        console.log(`    Native sign-in failed: ${signInResult.error}`)
      }
      await mainWindow.screenshot({
        path: 'test-results/vs-03b-after-native-signin-win.png',
      })
    }

    // Copilot interaction checkpoints require a real GitHub session. If native
    // sign-in didn't complete, fail fast with an actionable message — a silent
    // infra-only pass hid regressions in the past.
    if (!hasRealAuth) {
      throw new Error(
        'No Copilot auth available. Native VS Code sign-in did not complete. ' +
          'Ensure PLAYWRIGHT_GH_CLOUD_USER_EMAIL/PASSWORD and ' +
          'MOBB_CI_TEST_EMAIL_USERNAME/PASSWORD are set.'
      )
    }

    // The Mobb extension's CopilotMonitor checks for the Copilot extension ONCE
    // at activation — which happened at launch, BEFORE native sign-in, so it
    // logged "Copilot extension not installed" and never started. Reload the
    // window so the extension re-activates with the now-stored GitHub session
    // and Copilot present; otherwise no Copilot inference is captured.
    console.log('  Reloading window so CopilotMonitor detects Copilot...')
    const requestsBeforeReload = mockServer.getRequestLog().length
    await mainWindow.waitForTimeout(2000) // let VS Code persist the session
    await mainWindow.keyboard.press('Control+Shift+P')
    await mainWindow.waitForTimeout(1000)
    await mainWindow.keyboard.type('Reload Window')
    await mainWindow.waitForTimeout(1000)
    await mainWindow.keyboard.press('Enter')
    await mainWindow.waitForTimeout(5000) // reload tears down + restarts the host
    await mainWindow.waitForLoadState('domcontentloaded').catch(() => {})
    try {
      await mainWindow.waitForSelector('.monaco-workbench', { timeout: 30000 })
    } catch {
      console.log('  workbench not detected after reload, continuing')
    }
    // Wait for the Mobb extension to re-activate (fresh GraphQL requests).
    const reactivateStart = Date.now()
    while (
      mockServer.getRequestLog().length <= requestsBeforeReload &&
      Date.now() - reactivateStart < 45000
    ) {
      await mainWindow.waitForTimeout(1000)
    }
    console.log(
      `  Window reloaded; extension re-activated (requests: ${mockServer.getRequestLog().length})`
    )

    // ═══════════════════════════════════════════════════════════════════════
    // CHECKPOINT 5: Copilot AI Prompt Sent
    // ═══════════════════════════════════════════════════════════════════════
    await dismissDialogs(mainWindow)
    await mainWindow.screenshot({
      path: 'test-results/vs-04-dialogs-dismissed-win.png',
    })
    await openCopilotChat(mainWindow)
    const focused = await focusCopilotInput(mainWindow)
    console.log(`  Copilot chat input focused: ${focused}`)
    await mainWindow.screenshot({
      path: 'test-results/vs-05-copilot-chat-open-win.png',
    })

    const uniqueId = Date.now()
    const prompt = `Create a new file called utils-${uniqueId}.js with a simple add function that adds two numbers`

    await typeAndSubmitPrompt(mainWindow, prompt)
    tracker.mark('AI Prompt Sent')
    await mainWindow.screenshot({
      path: 'test-results/vs-06-prompt-submitted-win.png',
    })

    // Fail fast with a clear message if Copilot reports token invalid.
    await mainWindow.waitForTimeout(3000)
    if (copilotAuthInvalid) {
      throw new Error(
        'Copilot reports GitHub token is invalid/expired. The native sign-in ' +
          'token was rejected — check the test GitHub account and rerun.'
      )
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CHECKPOINT 6: Code Generated
    // ═══════════════════════════════════════════════════════════════════════
    const detected = await waitForCopilotGenerationAndAccept(
      mainWindow,
      AI_RESPONSE_TIMEOUT
    )
    if (detected) {
      tracker.mark('Code Generated')
    } else {
      console.log(
        '  Completion UI not detected — relying on tracy upload to confirm'
      )
    }
    await mainWindow.screenshot({
      path: 'test-results/vs-07-generation-complete-win.png',
    })

    // ═══════════════════════════════════════════════════════════════════════
    // CHECKPOINT 7: Tracy Records Uploaded
    // ═══════════════════════════════════════════════════════════════════════
    console.log('')
    console.log('  Waiting for tracy record upload...')
    console.log(`    Timeout: ${UPLOAD_WAIT_TIMEOUT}ms`)
    console.log(
      `    Current records: ${mockServer.getCapturedTracyRecords().length}`
    )

    try {
      await mockServer.waitForTracyRecords(1, {
        timeout: UPLOAD_WAIT_TIMEOUT,
        logInterval: EXTENSION_POLL_INTERVAL,
      })
      // Presence of tracy records is the authoritative signal that
      // Copilot actually generated output (Copilot text responses
      // don't trigger an edit-approval UI, so CHECKPOINT 6's button
      // detection was too narrow).
      tracker.mark('Code Generated')
      tracker.mark('Tracy Records Uploaded')
    } catch (err) {
      console.log(`  Tracy record wait failed: ${err}`)
      await mainWindow.screenshot({
        path: 'test-results/vs-error-upload-timeout-win.png',
      })
      captureExtensionLogs(testProfileDir)
      console.log(
        `  Request log: ${JSON.stringify(mockServer.getRequestLog(), null, 2)}`
      )
      throw err
    }

    const records = mockServer.getCapturedTracyRecords()
    console.log(`  Tracy records received: ${records.length}`)
    expect(records.length).toBeGreaterThanOrEqual(1)

    const chatRecords = records.filter((r) => !r.recordId.startsWith('ctx:'))
    console.log(
      `  Copilot chat records: ${chatRecords.length} (filtered ${records.length - chatRecords.length} context)`
    )
    expect(
      chatRecords.length,
      'No Copilot chat records captured'
    ).toBeGreaterThanOrEqual(1)

    for (let i = 0; i < Math.min(chatRecords.length, 3); i++) {
      console.log(`  ┌─ Record #${i + 1} ────────────────────`)
      assertCopilotRecordShape(chatRecords[i], mockServer)
      console.log('  └──────────────────────────────────')
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CHECKPOINT 8: Context Files Uploaded
    // ═══════════════════════════════════════════════════════════════════════
    tracker.logTimestamp('Validating context file upload')

    // Since T-476, each context file is uploaded individually to S3 with its
    // own Tracy record (recordId = "ctx:{sessionId}:{md5}") and a `context`
    // metadata field. Poll until the expected file appears.
    const ctxPollStart = Date.now()
    let allContextRecords: ReturnType<
      typeof mockServer.getCapturedTracyRecords
    > = []
    let copilotInstructionsRecord:
      | (typeof allContextRecords)[0]
      | undefined
    while (Date.now() - ctxPollStart < UPLOAD_WAIT_TIMEOUT) {
      allContextRecords = mockServer
        .getCapturedTracyRecords()
        .filter((r) => r.recordId?.startsWith('ctx:') && r.context)
      copilotInstructionsRecord = allContextRecords.find((r) =>
        r.context?.name?.endsWith('copilot-instructions.md')
      )
      if (copilotInstructionsRecord) break
      await new Promise((r) => setTimeout(r, 1000))
    }

    console.log(`  Context file records: ${allContextRecords.length} files`)
    for (const r of allContextRecords) {
      console.log(`    - ${r.context?.name} (${r.context?.category})`)
    }

    expect(
      copilotInstructionsRecord,
      '.github/copilot-instructions.md should be in context records'
    ).toBeTruthy()
    expect(copilotInstructionsRecord!.context?.category).toBe('rule')

    tracker.mark('Context Files Uploaded')
    tracker.logTimestamp('Test completed successfully')
  })
})
