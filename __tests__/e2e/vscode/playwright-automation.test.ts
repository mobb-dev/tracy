import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as zlib from 'node:zlib'

import { expect, test } from '@playwright/test'
import AdmZip from 'adm-zip'
import type { ElectronApplication, Page } from 'playwright'
import { _electron as electron } from 'playwright'

import { decodeAndDecompressBase64 } from '../shared/compression-utils'
import { initGitRepository } from '../shared/git-utils'
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
  installExtensionViaCli,
  patchExtensionsJsonRemoveBuiltinFlags,
  resolveVSCodeCliPath,
} from '../shared/vscode-test-helpers'
import { createVSCodeState } from './helpers/create-vscode-state'
import {
  loadCredentialsFromEnv,
  performDeviceFlowOAuth,
} from './helpers/device-flow-oauth'
import {
  captureExtensionLogs,
  captureExtensionOutput,
  dismissDialogs,
  focusCopilotInput,
  openCopilotChat,
  typeAndSubmitPrompt,
  waitForCopilotGenerationAndAccept,
} from './vscode-ui-helpers'
import { getVSCodeExecutablePath } from './vscode-helper'

// Test configuration — full Copilot interaction needs 6 minutes on a slow runner
const TEST_TIMEOUT = 360000 // 6 minutes
const AI_RESPONSE_TIMEOUT = 90000 // 90 seconds for Copilot to respond
const UPLOAD_WAIT_TIMEOUT = 60000 // 60 seconds for tracy upload (extension polls every 5s)
const EXTENSION_POLL_INTERVAL = 5000

// Safe screenshot helper with timeout and error handling
const SCREENSHOT_TIMEOUT = 15000 // 15 seconds max for screenshots
async function safeScreenshot(
  page: Page,
  filePath: string,
  _dismissDialogs = true
): Promise<void> {
  try {
    // Take screenshot with timeout
    await Promise.race([
      page.screenshot({ path: filePath, timeout: SCREENSHOT_TIMEOUT }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Screenshot timeout')),
          SCREENSHOT_TIMEOUT + 1000
        )
      ),
    ])
    console.log(`  📸 Screenshot saved: ${filePath}`)
  } catch (err) {
    console.log(`  ⚠️ Screenshot failed (${filePath}): ${err}`)
    // Don't throw - screenshots are non-critical
  }
}

/** Thin wrapper over the shared helper that upgrades the two pre-conditions
 * into Playwright `expect()` assertions so a missing S3 upload surfaces in
 * the test report rather than a bare thrown Error.
 */
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

/** Assert the full tracy record shape for a Copilot chat record. */
function assertCopilotRecordShape(
  record: TracyRecord,
  server: MockUploadServer
): void {
  expect(record.platform).toBe('COPILOT')
  expect(record.recordId).toBeTruthy()
  expect(record.recordTimestamp).toBeTruthy()
  expect(new Date(record.recordTimestamp).getTime()).toBeGreaterThan(0)
  expect(record.blameType).toBe('CHAT')
  expect(record.clientVersion).toMatch(/^\d+\.\d+\.\d+/)
  expect(record.computerName).toBeTruthy()
  expect(record.userName).toBeTruthy()

  const rawData = decodeCopilotRawData(record, server)
  expect(rawData.request).toBeDefined()
  expect(rawData.request.requestId).toBeTruthy()
  expect(rawData.metadata).toBeDefined()
  expect(rawData.metadata.sessionId).toBeTruthy()
}

/**
 * VS Code Extension E2E Test — Copilot interaction
 *
 * CHECKPOINT 1: VS Code installed
 * CHECKPOINT 2: Copilot extension installed
 * CHECKPOINT 3: Mobb extension installed
 * CHECKPOINT 4: Extension authenticated with mock server
 * CHECKPOINT 5: Copilot AI prompt sent
 * CHECKPOINT 6: Code generated
 * CHECKPOINT 7: Tracy records uploaded
 * CHECKPOINT 8: Context files uploaded
 *
 * The full flow runs on every invocation. `VSCODE_STATE_VSCDB_B64` must
 * be set to a portable state.vscdb captured from a Copilot-licensed
 * account; Device Flow OAuth is the fallback.
 */
test.describe('VS Code Extension E2E (Copilot)', () => {
  let testStartTime: number
  let mockServer: MockUploadServer
  let electronApp: ElectronApplication
  let mainWindow: Page
  let testProfileDir: string
  let vscodePid: number | undefined
  let hasRealAuth = false
  // Set to true when the extension host reports an expired GitHub/Copilot
  // token, so we can gracefully skip the AI-interaction checkpoints instead
  // of hanging on a tracy-upload timeout.
  let copilotAuthInvalid = false

  const tracker = new CheckpointTracker([
    'VS Code Installed',
    'Copilot Installed',
    'Extension Installed',
    'Mock Server Running',
    'Extension Authenticated',
    'AI Prompt Sent',
    'Code Generated',
    'Tracy Records Uploaded',
    'Context Files Uploaded',
  ])

  test.beforeAll(async () => {
    mockServer = new MockUploadServer(MOCK_SERVER_DEFAULT_PORT)
    await mockServer.start()
    console.log('✅ Mock server started')
    tracker.mark('Mock Server Running')
  })

  test.afterAll(async () => {
    await mockServer.stop()
    console.log('✅ Mock server stopped')
  })

  test.beforeEach(async () => {
    test.setTimeout(TEST_TIMEOUT)

    // Ensure test-results directory exists
    const testResultsDir = path.join(
      __dirname,
      '..',
      '..',
      '..',
      'test-results'
    )
    if (!fs.existsSync(testResultsDir)) {
      fs.mkdirSync(testResultsDir, { recursive: true })
    }

    // Create isolated test profile directory
    const tempBase = process.env.TEST_TEMP_DIR || os.tmpdir()
    testProfileDir = path.join(
      tempBase,
      `vscode-e2e-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    fs.mkdirSync(testProfileDir, { recursive: true })
    console.log(`✅ Created test profile: ${testProfileDir}`)

    // Create User/globalStorage directory structure
    const globalStorageDir = path.join(testProfileDir, 'User', 'globalStorage')
    fs.mkdirSync(globalStorageDir, { recursive: true })

    // Create VS Code settings
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
      // Auto-accept Copilot Agent edits without confirmation dialogs
      'chat.editing.autoAcceptDelay': 500,
      'chat.editing.confirmEditRequestRemoval': false,
      'chat.editing.confirmEditRequestRetry': false,
      // Allow Copilot to edit files outside workspace
      'github.copilot.chat.edits.allowFilesOutsideWorkspace': true,
      // Try to auto-approve all chat tools (may bypass "Allow edits" dialog)
      // WARNING: This disables critical security protections - only for testing!
      'chat.tools.global.autoApprove': true,
      'chat.tools.terminal.autoApprove': true,
      // Don't block extensions that lack signatures in test runs. VS Code
      // 1.103+ defaults this to true and quietly disables side-loaded exts.
      'extensions.verifySignature': false,
      'extensions.autoUpdate': false,
      'extensions.autoCheckUpdates': false,
    }
    fs.writeFileSync(settingsPath, JSON.stringify(testSettings, null, 2))
    console.log('✅ Created VS Code settings with mock server URL')

    // Setup auth from pre-built credentials or fallback methods
    hasRealAuth = await setupAuth(globalStorageDir)

    // Setup extensions directory
    const extensionsDir = path.join(testProfileDir, 'User', 'extensions')
    fs.mkdirSync(extensionsDir, { recursive: true })
    fs.mkdirSync(path.join(testProfileDir, 'extensions'), { recursive: true })

    // Install extensions
    await installExtensions(extensionsDir)

    // Validate installation
    await validateExtensionInstallation(testProfileDir)
  })

  test.afterEach(async () => {
    tracker.logTimestamp('Cleanup started (afterEach)')

    // Archive all extension logs BEFORE profile cleanup
    captureExtensionLogs(testProfileDir)
    dumpExtensionsJson(
      path.join(testProfileDir, 'User', 'extensions'),
      'afterEach'
    )

    // Close VS Code
    if (vscodePid) {
      try {
        process.kill(vscodePid, 'SIGKILL')
        tracker.logTimestamp(`Force killed VS Code (PID: ${vscodePid})`)
      } catch (killError) {
        console.log(`ℹ️  VS Code already exited: ${killError}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    // Clean up test profile directory
    if (testProfileDir && fs.existsSync(testProfileDir)) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          fs.rmSync(testProfileDir, { recursive: true, force: true })
          tracker.logTimestamp('Test profile cleaned up')
          break
        } catch (cleanupError) {
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 1000))
          }
        }
      }
    }

    mockServer.clearAll()
    tracker.logTimestamp('Cleanup complete (afterEach)')

    // Print checkpoint summary
    tracker.printSummary()
  })

  test('should install extension and authenticate (infrastructure-only)', async () => {
    testStartTime = Date.now()
    tracker.logTimestamp('Test started')

    const workspaceDir = path.join(__dirname, '..', 'shared', 'test-workspace')
    const extensionsDir = path.join(testProfileDir, 'User', 'extensions')

    // Initialize git repository
    await initGitRepository(workspaceDir)

    // ═══════════════════════════════════════════════════════════════════════════
    // CHECKPOINT 1: VS Code Installed
    // ═══════════════════════════════════════════════════════════════════════════
    await test.step('CHECKPOINT 1: VS Code Installed', async () => {
      tracker.logTimestamp('CHECKPOINT 1: VS Code Installed')
      const vscodePath = getVSCodeExecutablePath()
      console.log(`\n${'═'.repeat(60)}`)
      console.log('CHECKPOINT 1: VS Code Installed')
      console.log('═'.repeat(60))
      console.log(`  Path: ${vscodePath}`)

      const vscodeExists = fs.existsSync(vscodePath)
      expect(
        vscodeExists,
        `VS Code executable not found at: ${vscodePath}`
      ).toBe(true)

      // Check VS Code version (requires --no-sandbox and --user-data-dir when running as root)
      console.log(`  🔍 Checking VS Code version...`)
      try {
        console.log(
          `  🔍 Running: "${vscodePath}" --no-sandbox --user-data-dir=/tmp/vscode-version-check --version`
        )
        const versionOutput = execSync(
          `"${vscodePath}" --no-sandbox --user-data-dir=/tmp/vscode-version-check --version`,
          {
            encoding: 'utf8',
            timeout: 10000, // 10 second timeout
          }
        )
        console.log(`  ✅ Version check completed`)
        const versionLines = versionOutput.trim().split('\n')
        console.log(`  VS Code version: ${versionLines[0]}`)
        console.log(`  Commit: ${versionLines[1]}`)

        // Parse version to verify it's recent enough (>= 1.108.0 for Copilot compatibility)
        const versionMatch = versionLines[0].match(/(\d+)\.(\d+)\.(\d+)/)
        if (versionMatch) {
          const major = parseInt(versionMatch[1])
          const minor = parseInt(versionMatch[2])
          if (major < 1 || (major === 1 && minor < 108)) {
            console.log(
              '  ⚠️  VS Code version may be too old for latest Copilot'
            )
            console.log('     Minimum required: 1.108.0')
          } else {
            console.log(
              '  ✅ VS Code version is compatible with latest Copilot'
            )
          }
        }
      } catch (e) {
        console.log(`  ⚠️  Could not check VS Code version: ${e}`)
      }

      console.log('  ✅ VS Code executable found')
      tracker.mark('VS Code Installed')
    })

    console.log('🔄 Moving to CHECKPOINT 2...')

    // ═══════════════════════════════════════════════════════════════════════════
    // CHECKPOINT 2: Copilot Installed
    // ═══════════════════════════════════════════════════════════════════════════
    await test.step('CHECKPOINT 2: Copilot Installed', async () => {
      tracker.logTimestamp('CHECKPOINT 2: Copilot Installed')
      console.log(`\n${'═'.repeat(60)}`)
      console.log('CHECKPOINT 2: Copilot Installed')
      console.log('═'.repeat(60))

      const installedExts = fs.readdirSync(extensionsDir)
      console.log(`  Installed extensions: ${installedExts.join(', ')}`)

      const copilotExtension = installedExts.find((e) =>
        e.startsWith('github.copilot-')
      )
      const copilotChatExtension = installedExts.find((e) =>
        e.startsWith('github.copilot-chat')
      )

      expect(
        copilotExtension,
        'GitHub Copilot extension not found in extensions directory'
      ).toBeTruthy()
      expect(
        copilotChatExtension,
        'GitHub Copilot Chat extension not found in extensions directory'
      ).toBeTruthy()

      // Check Copilot extension versions
      try {
        const copilotPath = path.join(extensionsDir, copilotExtension!)
        const copilotChatPath = path.join(extensionsDir, copilotChatExtension!)

        const copilotPkg = JSON.parse(
          fs.readFileSync(path.join(copilotPath, 'package.json'), 'utf8')
        )
        const copilotChatPkg = JSON.parse(
          fs.readFileSync(path.join(copilotChatPath, 'package.json'), 'utf8')
        )

        console.log(`  ✅ Found: ${copilotExtension} (v${copilotPkg.version})`)
        console.log(
          `  ✅ Found: ${copilotChatExtension} (v${copilotChatPkg.version})`
        )

        // Check VS Code compatibility
        if (copilotChatPkg.engines?.vscode) {
          console.log(
            `     Copilot Chat requires VS Code: ${copilotChatPkg.engines.vscode}`
          )
        }
      } catch (e) {
        console.log(`  ✅ Found: ${copilotExtension}`)
        console.log(`  ✅ Found: ${copilotChatExtension}`)
      }

      tracker.mark('Copilot Installed')
    })

    // ═══════════════════════════════════════════════════════════════════════════
    // CHECKPOINT 3: Mobb Extension Installed
    // ═══════════════════════════════════════════════════════════════════════════
    await test.step('CHECKPOINT 3: Mobb Extension Installed', async () => {
      tracker.logTimestamp('CHECKPOINT 3: Mobb Extension Installed')
      console.log(`\n${'═'.repeat(60)}`)
      console.log('CHECKPOINT 3: Mobb Extension Installed')
      console.log('═'.repeat(60))

      const installedExts = fs.readdirSync(extensionsDir)
      console.log(`  Installed extensions: ${installedExts.join(', ')}`)
      const mobbExtension = installedExts.find((e) =>
        e.toLowerCase().startsWith('mobb.mobb-ai-tracer')
      )

      expect(
        mobbExtension,
        'Mobb AI Tracer extension not found in extensions directory'
      ).toBeTruthy()

      // Verify critical files
      const extensionDir = path.join(extensionsDir, mobbExtension!)
      const requiredFiles = ['package.json', 'out/extension.js']
      for (const file of requiredFiles) {
        const filePath = path.join(extensionDir, file)
        expect(fs.existsSync(filePath), `Missing required file: ${file}`).toBe(
          true
        )
      }
      // runtime.config.json is optional (only in test builds)
      const runtimeConfigPath = path.join(
        extensionDir,
        'out',
        'runtime.config.json'
      )
      if (fs.existsSync(runtimeConfigPath)) {
        console.log('  ✅ Found runtime.config.json (test build)')
      } else {
        console.log(
          '  ℹ️  No runtime.config.json (dev build - will use VS Code settings)'
        )
      }

      console.log(`  ✅ Found: ${mobbExtension}`)
      console.log('  ✅ All required files present')
      tracker.mark('Extension Installed')
    })

    // Debug: Print profile structure before launch
    console.log('\n📂 Test Profile Structure:')
    console.log(`  Profile dir: ${testProfileDir}`)
    console.log(`  Extensions dir: ${extensionsDir}`)
    const installedExts = fs.readdirSync(extensionsDir)
    console.log(`  Installed extensions: ${installedExts.join(', ')}`)

    // Check settings file
    const settingsPath = path.join(testProfileDir, 'User', 'settings.json')
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      console.log(`  Settings apiUrl: ${settings['mobbAiTracer.apiUrl']}`)
    }

    // Check extension has runtime.config.json
    const mobbExt = installedExts.find((e) => e.startsWith('mobb.'))
    if (mobbExt) {
      const configPath = path.join(
        extensionsDir,
        mobbExt,
        'out',
        'runtime.config.json'
      )
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
        console.log(`  Extension runtime config API_URL: ${config.API_URL}`)
      } else {
        console.log(`  ⚠️ runtime.config.json NOT FOUND at ${configPath}`)
      }
    }

    // Launch VS Code
    console.log('\n🚀 Launching VS Code...')
    const vscodePath = getVSCodeExecutablePath()
    const workspaceFolderUri = `file://${workspaceDir}`
    electronApp = await electron.launch({
      executablePath: vscodePath,
      args: [
        `--user-data-dir=${testProfileDir}`,
        `--extensions-dir=${extensionsDir}`,
        '--no-sandbox', // Required when running as root in Docker
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--password-store=basic', // Use basic password store for infrastructure-only testing
        // Copilot + Copilot Chat declare proposed API usage in their
        // package.json. Without this flag VS Code silently disables them at
        // startup. Use space-separated form (Electron sometimes mis-parses
        // `=` form in extension.js-hosted flags). Also try comma-joined.
        '--enable-proposed-api',
        'GitHub.copilot',
        '--enable-proposed-api',
        'GitHub.copilot-chat',
        // Disable gallery so VS Code doesn't try to "sync" extensions and
        // uninstall side-loaded ones it considers not-in-gallery.
        '--disable-telemetry',
        `--folder-uri=${workspaceFolderUri}`,
      ],
      env: {
        ...process.env,
        API_URL: MOCK_API_URL_DEFAULT,
        MOBB_API_URL: MOCK_MOBB_API_URL_DEFAULT,
        MOBB_API_TOKEN: TEST_MOBB_API_TOKEN,
        NODE_ENV: 'test',
        // CRITICAL: Disable proxy for localhost connections
        // The extension's GraphQL client uses HTTP_PROXY/HTTPS_PROXY but doesn't
        // exclude localhost by default. Setting NO_PROXY prevents proxy usage for local mock server.
        NO_PROXY: 'localhost,127.0.0.1,::1',
        no_proxy: 'localhost,127.0.0.1,::1', // lowercase variant for compatibility
      },
      timeout: 60000,
    })

    mainWindow = await electronApp.firstWindow()
    vscodePid = electronApp.process()?.pid
    console.log(`📍 VS Code PID: ${vscodePid}`)

    // Reset per-test auth-error flag
    copilotAuthInvalid = false

    // Log console messages for debugging and watch for the specific Copilot
    // auth-expired signal so we can downgrade to infrastructure-only cleanly.
    mainWindow.on('console', (msg) => {
      const text = msg.text()
      // Skip only the most noisy deprecation warnings
      if (
        text.includes(
          '[DEP0040] DeprecationWarning: The `punycode` module is deprecated'
        ) ||
        text.includes('ExperimentalWarning: SQLite is an experimental feature')
      ) {
        return // Skip logging these specific messages
      }
      if (
        text.includes('Your GitHub token is invalid') ||
        text.includes('sign out from your GitHub account')
      ) {
        copilotAuthInvalid = true
      }
      console.log(`  [Console ${msg.type()}] ${text}`)
    })

    await mainWindow.waitForLoadState('domcontentloaded')
    await safeScreenshot(mainWindow, 'test-results/vs-01-loaded.png')

    try {
      await mainWindow.waitForSelector('.monaco-workbench', { timeout: 10000 })
      tracker.logTimestamp('VS Code workbench loaded')
    } catch {
      await mainWindow.waitForTimeout(3000)
      tracker.logTimestamp('VS Code ready (fallback timeout)')
    }
    await safeScreenshot(mainWindow, 'test-results/vs-02-workbench-ready.png')

    // Post-launch diagnostic dump — did VS Code modify extensions.json?
    dumpExtensionsJson(
      path.join(testProfileDir, 'User', 'extensions'),
      'post-launch'
    )

    // DEBUGGING: Pause here to allow VNC inspection
    if (process.env.ENABLE_VNC_DEBUG === 'true') {
      console.log(`\n${'═'.repeat(60)}`)
      console.log('🔍 VNC DEBUG MODE - Test Paused')
      console.log('═'.repeat(60))
      console.log('VS Code is running and ready for inspection!')
      console.log(`VS Code PID: ${vscodePid}`)
      console.log(`Test profile: ${testProfileDir}`)
      console.log('')
      console.log('VNC Connection:')
      console.log('  Host: localhost')
      console.log('  Port: 5900 (mapped to 15900 on host)')
      console.log('  Connect: vnc://localhost:15900')
      console.log('')
      console.log('Extensions installed:')
      const exts = fs.readdirSync(
        path.join(testProfileDir, 'User', 'extensions')
      )
      for (const ext of exts) {
        console.log(`  - ${ext}`)
      }
      console.log('')
      console.log('⏸️  Test will wait for 10 minutes.')
      console.log('   Press Ctrl+C to exit when done inspecting.')
      console.log(`${'═'.repeat(60)}\n`)

      // Wait 10 minutes (600 seconds)
      for (let i = 0; i < 600; i++) {
        await mainWindow.waitForTimeout(1000)
        if (i % 30 === 0 && i > 0) {
          console.log(
            `  ⏱️  Still waiting... (${Math.floor(i / 60)}m ${i % 60}s elapsed)`
          )
        }
      }
      console.log('🔍 VNC debug timeout reached, continuing test...\n')
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CHECKPOINT 4: Mobb Extension Logged In
    // ═══════════════════════════════════════════════════════════════════════════
    await test.step('CHECKPOINT 4: Mobb Extension Logged In', async () => {
      tracker.logTimestamp('CHECKPOINT 4: Mobb Extension Logged In')
      console.log(`\n${'═'.repeat(60)}`)
      console.log('CHECKPOINT 4: Mobb Extension Logged In')
      console.log('═'.repeat(60))

      const activationStartTime = Date.now()
      const activationTimeout = 30000
      console.log('  Waiting for extension activation (up to 30s)...')
      let lastLoggedCount = 0
      // Wait for the FULL set of operations the assertions below check —
      // not just for "any request" — so the loop doesn't bail between
      // verifyApiConnection's `Me` and validateUserToken's `CreateCommunityUser`
      // and miss the second one. The poll-too-early race was the cause of
      // the "did not perform login/org resolution" flake on Linux CI.
      const hasFullActivation = (): boolean => {
        const ops = mockServer
          .getRequestLog()
          .map((r) => r.body?.operationName)
        return (
          ops.includes('Me') &&
          (ops.includes('CreateCommunityUser') || ops.includes('getLastOrg'))
        )
      }
      while (
        !hasFullActivation() &&
        Date.now() - activationStartTime < activationTimeout
      ) {
        await mainWindow.waitForTimeout(1000)
        const elapsed = Math.floor((Date.now() - activationStartTime) / 1000)
        const current = mockServer.getRequestLog()
        // Log on every 5s tick OR when a new request lands. The op-name list
        // is what we actually need to triage activation/handshake races —
        // a bare count can't distinguish 'verifyApiConnection' from 'Me'.
        if (current.length !== lastLoggedCount || elapsed % 5 === 0) {
          const ops = current
            .map((r) => r.body?.operationName)
            .filter(Boolean)
            .join(', ')
          console.log(
            `  ... ${elapsed}s elapsed, requests: ${current.length}${ops ? ` [${ops}]` : ''}`
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
        `  Mock server requests: ${requests.length}${finalOps ? ` [${finalOps}]` : ''}`
      )

      expect(
        requests.length,
        'Extension made no GraphQL requests — activation failed'
      ).toBeGreaterThan(0)

      const meQuery = requests.find((r) => r.body?.operationName === 'Me')
      const hasLoginActivity =
        requests.some((r) => r.body?.operationName === 'CreateCommunityUser') ||
        requests.some((r) => r.body?.operationName === 'getLastOrg')

      expect(
        meQuery,
        'Extension did not call Me query — auth handshake missing'
      ).toBeTruthy()
      expect(
        hasLoginActivity,
        'Extension did not perform login/org resolution'
      ).toBeTruthy()

      console.log('  Extension activated and authenticated')
      console.log(`  Made ${requests.length} GraphQL requests`)
      tracker.mark('Extension Authenticated')
    })

    // Copilot interaction checkpoints require a working state.vscdb. If the
    // test secret is missing or decoding failed, fail fast with an actionable
    // message — a silent infra-only pass hid regressions in the past.
    if (!hasRealAuth) {
      throw new Error(
        'No Copilot auth available. Set VSCODE_STATE_VSCDB_B64 ' +
          '(see scripts/refresh-vscode-auth.sh) or provide Device Flow ' +
          'credentials (PLAYWRIGHT_GH_CLOUD_USER_EMAIL/PASSWORD).'
      )
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CHECKPOINT 5: Copilot AI Prompt Sent
    // ═══════════════════════════════════════════════════════════════════════════
    const uniqueId = Date.now()
    const prompt = `Create a new file called utils-${uniqueId}.js with a simple add function that adds two numbers`

    await test.step('CHECKPOINT 5: Copilot AI Prompt Sent', async () => {
      console.log(`\n${'═'.repeat(60)}`)
      console.log('CHECKPOINT 5: Copilot AI Prompt Sent')
      console.log('═'.repeat(60))

      await dismissDialogs(mainWindow)
      await safeScreenshot(mainWindow, 'test-results/vs-03-dialogs-dismissed.png')
      await openCopilotChat(mainWindow)
      await safeScreenshot(mainWindow, 'test-results/vs-04-copilot-chat-open.png')
      const focused = await focusCopilotInput(mainWindow)
      console.log(`  Chat input focused: ${focused}`)

      await typeAndSubmitPrompt(mainWindow, prompt)
      tracker.mark('AI Prompt Sent')
      tracker.logTimestamp('Prompt submitted')
      await safeScreenshot(mainWindow, 'test-results/vs-05-prompt-submitted.png')
    })

    // Surface auth errors loudly — if the Copilot GitHub token is invalid,
    // we want CI to fail with a clear message pointing at the secret to
    // refresh, not silently pass.
    await mainWindow.waitForTimeout(3000)
    if (copilotAuthInvalid) {
      throw new Error(
        'Copilot reports GitHub token is invalid/expired. ' +
          'Refresh GITHUB_COPILOT_PAT (or VSCODE_STATE_VSCDB_B64) and rerun.'
      )
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CHECKPOINT 6: Code Generated
    // ═══════════════════════════════════════════════════════════════════════════
    await test.step('CHECKPOINT 6: Code Generated', async () => {
      console.log(`\n${'═'.repeat(60)}`)
      console.log('CHECKPOINT 6: Code Generated')
      console.log('═'.repeat(60))

      // Give Copilot a moment to start streaming before we look for completion.
      await mainWindow.waitForTimeout(3000)
      await safeScreenshot(mainWindow, 'test-results/vs-06-generating.png')

      const detected = await waitForCopilotGenerationAndAccept(
        mainWindow,
        AI_RESPONSE_TIMEOUT
      )
      if (detected) {
        tracker.mark('Code Generated')
      } else {
        console.log(
          '  Completion UI not detected — upload wait will still verify the record pipeline'
        )
      }
      tracker.logTimestamp('Copilot generation phase complete')
      await safeScreenshot(mainWindow, 'test-results/vs-07-generation-complete.png')
    })

    // Capture extension output (best-effort) for CI debugging
    try {
      await captureExtensionOutput(mainWindow, electronApp)
    } catch (err) {
      console.log(`  captureExtensionOutput skipped: ${err}`)
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CHECKPOINT 7: Tracy Records Uploaded
    // ═══════════════════════════════════════════════════════════════════════════
    await test.step('CHECKPOINT 7: Tracy Records Uploaded', async () => {
      console.log(`\n${'═'.repeat(60)}`)
      console.log('CHECKPOINT 7: Tracy Records Uploaded')
      console.log('═'.repeat(60))

      try {
        await mockServer.waitForTracyRecords(1, {
          timeout: UPLOAD_WAIT_TIMEOUT,
          logInterval: EXTENSION_POLL_INTERVAL,
        })
      } catch (err) {
        captureExtensionLogs(testProfileDir)
        throw err
      }

      // The presence of tracy records is the authoritative signal that
      // Copilot generated a response. The UI-button detection in
      // CHECKPOINT 6 is optional (not every Copilot response triggers an
      // edit-approval flow — text replies don't).
      tracker.mark('Code Generated')

      const records = mockServer.getCapturedTracyRecords()
      expect(records.length).toBeGreaterThanOrEqual(1)
      console.log(`  Tracy records received: ${records.length}`)

      // Filter out per-file context records (recordId prefix `ctx:`) which
      // have a `context` metadata field and are validated in CHECKPOINT 8.
      const chatRecords = records.filter((r) => !r.recordId.startsWith('ctx:'))
      console.log(
        `  Copilot chat records: ${chatRecords.length} (filtered ${records.length - chatRecords.length} context)`
      )
      expect(
        chatRecords.length,
        'No Copilot chat records captured (only context-file records)'
      ).toBeGreaterThanOrEqual(1)

      for (let i = 0; i < Math.min(chatRecords.length, 3); i++) {
        assertCopilotRecordShape(chatRecords[i], mockServer)
      }

      tracker.mark('Tracy Records Uploaded')
      tracker.logTimestamp('Tracy records validated', {
        count: records.length,
        chatRecords: chatRecords.length,
      })
    })

    // ═══════════════════════════════════════════════════════════════════════════
    // CHECKPOINT 8: Context Files Uploaded
    // ═══════════════════════════════════════════════════════════════════════════
    await test.step('CHECKPOINT 8: Context Files Uploaded', async () => {
      console.log(`\n${'═'.repeat(60)}`)
      console.log('CHECKPOINT 8: Context Files Uploaded')
      console.log('═'.repeat(60))

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
        // Copilot's context-file scanner reads .github/copilot-instructions.md
        // (not .cursorrules — that's Cursor's convention). The shared test
        // workspace ships a matching file.
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
      tracker.logTimestamp('Context files validated')
    })

    tracker.logTimestamp('Test completed')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * PRIORITY 0 (highest): Build state.vscdb from a GitHub PAT.
 *
 * The cleanest "token ready to apply" path — the PAT is long-lived, lives
 * in the __tests__/.env dotenv-vault, and the createVSCodeState helper
 * turns it into a valid state.vscdb on any platform (no safeStorage /
 * machine-bound encryption involved).
 *
 * Env: GITHUB_COPILOT_PAT — a PAT owned by a Copilot-licensed GitHub
 * account (e.g. citestjob@mobb.ai), pulled from PLAYWRIGHT_GH_CLOUD_PAT.
 */
async function loadAuthFromPAT(globalStorageDir: string): Promise<boolean> {
  const pat = process.env.GITHUB_COPILOT_PAT
  if (!pat) return false

  console.log(
    `🔐 Using GITHUB_COPILOT_PAT (PAT-based auth, ${pat.length} chars)`
  )
  try {
    const targetPath = path.join(globalStorageDir, 'state.vscdb')
    await createVSCodeState(pat, targetPath)
    console.log(`✅ Wrote fresh state.vscdb from PAT`)
    return true
  } catch (err) {
    console.log(`⚠️ Failed to build state.vscdb from PAT: ${err}`)
    return false
  }
}

/**
 * PRIORITY 1: Load auth from base64-encoded env var (primary method for CI/Docker)
 * Uses Linux-native auth created via manual VNC capture
 */
function loadAuthFromBase64EnvVar(globalStorageDir: string): boolean {
  if (!process.env.VSCODE_STATE_VSCDB_B64) {
    return false
  }

  const secretLength = process.env.VSCODE_STATE_VSCDB_B64.length
  console.log(
    `🔐 Using VSCODE_STATE_VSCDB_B64 (primary auth method, ${secretLength} chars)`
  )

  const stateContent = decodeAndDecompressBase64(
    process.env.VSCODE_STATE_VSCDB_B64,
    false // minimal logging for VS Code test
  )

  const targetPath = path.join(globalStorageDir, 'state.vscdb')
  fs.writeFileSync(targetPath, stateContent)
  console.log(`✅ Wrote state.vscdb (${stateContent.length} bytes)`)
  return true
}

/**
 * PRIORITY 2: Load auth from directory specified in env var
 */
function loadAuthFromDirectory(globalStorageDir: string): boolean {
  if (!process.env.VSCODE_AUTH_DIR) {
    return false
  }

  const authFiles = ['state.vscdb', 'storage.json']
  const authDir = process.env.VSCODE_AUTH_DIR
  let authCopied = false

  for (const authFile of authFiles) {
    const sourcePath = path.join(authDir, authFile)
    const targetPath = path.join(globalStorageDir, authFile)
    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, targetPath)
      console.log(`✅ Copied auth from VSCODE_AUTH_DIR: ${authFile}`)
      authCopied = true
    }
  }

  return authCopied
}

/**
 * PRIORITY 3: Load auth from local base64-encoded file (for local development)
 * IMPORTANT: VS Code safeStorage encryption is machine-specific!
 */
function loadAuthFromLocalFile(globalStorageDir: string): boolean {
  // Check in auth/ directory first (preferred location)
  const authDirLinux = path.join(__dirname, 'auth', 'vscode-auth-linux.b64')
  const authDirMacos = path.join(__dirname, 'auth', 'vscode-auth.b64')

  // Fallback to old locations (root of vscode/ directory)
  const linuxAuthFile = path.join(__dirname, 'vscode-auth-linux.b64')
  const macosAuthFile = path.join(__dirname, 'vscode-auth.b64')

  let authFile = ''

  // Try auth/ directory first
  if (process.platform === 'linux' && fs.existsSync(authDirLinux)) {
    authFile = authDirLinux
    console.log(`🔐 Found Linux-native auth file: ${authFile}`)
  } else if (fs.existsSync(authDirMacos)) {
    authFile = authDirMacos
    console.log(`🔐 Found auth file in auth/: ${authFile}`)
    if (process.platform === 'linux') {
      console.log(
        `⚠️  Warning: Using macOS auth file on Linux - this may not work!`
      )
      console.log(
        `   Run scripts/create-docker-auth.sh to create Linux-native auth`
      )
    }
  }
  // Fallback to old locations
  else if (process.platform === 'linux' && fs.existsSync(linuxAuthFile)) {
    authFile = linuxAuthFile
    console.log(`🔐 Found Linux-native auth file: ${authFile}`)
  } else if (fs.existsSync(macosAuthFile)) {
    authFile = macosAuthFile
    console.log(`🔐 Found local auth file: ${authFile}`)
    if (process.platform === 'linux') {
      console.log(
        `⚠️  Warning: Using macOS auth file on Linux - this may not work!`
      )
      console.log(
        `   Run scripts/create-docker-auth.sh to create Linux-native auth`
      )
    }
  }

  if (!authFile) {
    return false
  }

  const base64Content = fs.readFileSync(authFile, 'utf8').trim()
  const stateContent = decodeAndDecompressBase64(base64Content, false)

  const targetPath = path.join(globalStorageDir, 'state.vscdb')
  fs.writeFileSync(targetPath, stateContent)
  console.log(`✅ Wrote state.vscdb from local file`)
  return true
}

/**
 * PRIORITY 4: Load auth from local VS Code installation (for local development)
 */
function loadAuthFromLocalInstallation(globalStorageDir: string): boolean {
  const authFiles = ['state.vscdb', 'storage.json']

  let userVSCodeGlobalStorage = ''
  if (process.platform === 'darwin') {
    userVSCodeGlobalStorage = path.join(
      process.env.HOME || '',
      'Library/Application Support/Code/User/globalStorage'
    )
  } else if (process.platform === 'linux') {
    userVSCodeGlobalStorage = path.join(
      process.env.HOME || '',
      '.config/Code/User/globalStorage'
    )
  } else if (process.platform === 'win32') {
    userVSCodeGlobalStorage = path.join(
      process.env.APPDATA || '',
      'Code/User/globalStorage'
    )
  }

  if (!userVSCodeGlobalStorage || !fs.existsSync(userVSCodeGlobalStorage)) {
    return false
  }

  let authCopied = false
  for (const authFile of authFiles) {
    const sourcePath = path.join(userVSCodeGlobalStorage, authFile)
    const targetPath = path.join(globalStorageDir, authFile)
    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, targetPath)
      console.log(`✅ Copied VS Code auth file: ${authFile}`)
      authCopied = true
    }
  }

  return authCopied
}

/**
 * PRIORITY 0: Load auth via Device Flow OAuth (primary path — yields a fresh
 * OAuth token that the GitHub Authentication provider + Copilot Chat accept).
 */
async function loadAuthFromDeviceFlow(
  globalStorageDir: string
): Promise<boolean> {
  const credentials = loadCredentialsFromEnv()

  if (!credentials) {
    return false // caller falls through to other priority paths
  }

  console.log('🔐 Running Device Flow OAuth to mint a fresh GitHub token...')
  console.log(`   Account: ${credentials.email}`)

  try {
    const result = await performDeviceFlowOAuth(credentials, {
      headless: true, // Run headlessly in CI
      timeout: 120, // 2 minutes max
      useFirefox: true, // Firefox works better in Docker (no snap issues)
    })

    if (result.success && result.accessToken) {
      console.log('✅ Device Flow OAuth successful!')

      // Create state.vscdb with the OAuth token
      const targetPath = path.join(globalStorageDir, 'state.vscdb')
      await createVSCodeState(result.accessToken, targetPath)

      console.log(`✅ Created state.vscdb with GitHub auth`)
      return true
    }

    console.log(`⚠️ Device Flow OAuth failed: ${result.error}`)
    return false
  } catch (oauthError) {
    console.log(`⚠️ Device Flow OAuth error: ${oauthError}`)
    return false
  }
}

/**
 * Setup authentication for VS Code by trying multiple methods in priority order
 */
async function setupAuth(globalStorageDir: string): Promise<boolean> {
  // IMPORTANT ordering: use the pre-captured state.vscdb FIRST. That secret
  // comes from a portable profile that interactively clicked through every
  // sign-in + AI-features modal, so it has the opt-in markers VS Code 1.116
  // checks at launch. A Device-Flow-minted state.vscdb lacks those markers
  // and leaves the AI-features modal sitting in front of the chat panel.
  let ok = false
  if (loadAuthFromBase64EnvVar(globalStorageDir)) ok = true
  else if (loadAuthFromDirectory(globalStorageDir)) ok = true
  else if (loadAuthFromLocalFile(globalStorageDir)) ok = true
  else if (loadAuthFromLocalInstallation(globalStorageDir)) ok = true
  else if (await loadAuthFromDeviceFlow(globalStorageDir)) ok = true
  else if (await loadAuthFromPAT(globalStorageDir)) ok = true

  if (ok) {
    // ATTEMPT 4: Write explicit enablement state into state.vscdb so VS Code
    // treats Copilot + Copilot Chat as user-enabled, bypassing the
    // filterEnabledExtensions "is disabled" path. This uses the
    // ExtensionEnablementService's storage key format.
    forceEnableCopilotInStateDb(
      path.join(globalStorageDir, 'state.vscdb')
    )
    return true
  }

  console.log('⚠️ No VS Code auth available - Copilot will not work')
  console.log(
    '   Set PLAYWRIGHT_GH_CLOUD_USER_EMAIL/PASSWORD for Device Flow,'
  )
  console.log('   or GITHUB_COPILOT_PAT, or VSCODE_STATE_VSCDB_B64.')
  return false
}

/**
 * Install GitHub Copilot + Copilot Chat extensions into the per-test profile
 * using `code --install-extension <vsix>`. Going through the CLI (rather than
 * copying unpacked folders) generates the signature files (`.sigzip`) and
 * registry entries that VS Code 1.103+ requires before enabling an extension.
 * Without this, startup logs `filterEnabledExtensions: extension '...' is
 * disabled` and Copilot never fires.
 *
 * VSIX files live in $COPILOT_VSIX_DIR in CI (downloaded in the workflow).
 * For local runs we fall back to $HOME/.vscode/extensions folder copies.
 */
async function installCopilotExtensions(extensionsDir: string): Promise<void> {
  const vsixDir = process.env.COPILOT_VSIX_DIR
  if (vsixDir && fs.existsSync(vsixDir)) {
    const vsixFiles = fs
      .readdirSync(vsixDir)
      .filter((f) => f.toLowerCase().endsWith('.vsix'))
      .map((f) => path.join(vsixDir, f))

    if (vsixFiles.length === 0) {
      console.log(`⚠️ No VSIX files found in ${vsixDir}`)
    }

    for (const vsix of vsixFiles) {
      installViaCli(vsix, extensionsDir)
    }

    // VS Code 1.103+ ships `github.copilot-chat` as a built-in and refuses to
    // install the marketplace VSIX on top of it ("built-in extension cannot
    // be downgraded"). `code --install-extension` fails silently and leaves
    // chat out of the per-profile extensions dir. Fall back to copying the
    // built-in directly — mirrors what the Docker image already does.
    ensureCopilotChatBuiltin(extensionsDir)
    return
  }

  // Local-dev fallback: copy from user's ~/.vscode/extensions. This path
  // doesn't produce signature files so only works on local VS Code installs
  // that trust side-loaded extensions.
  const homeDir =
    process.platform === 'win32'
      ? process.env.USERPROFILE || ''
      : process.env.HOME || ''
  const localExtensionsDir = path.join(homeDir, '.vscode/extensions')
  if (!fs.existsSync(localExtensionsDir)) {
    console.log(
      '⚠️ COPILOT_VSIX_DIR unset and no local ~/.vscode/extensions — Copilot will not be available'
    )
    return
  }

  const copilotExts = fs
    .readdirSync(localExtensionsDir)
    .filter(
      (e) =>
        e.startsWith('github.copilot-') || e.startsWith('github.copilot-chat')
    )
  for (const ext of copilotExts) {
    const src = path.join(localExtensionsDir, ext)
    const dst = path.join(extensionsDir, ext)
    if (fs.statSync(src).isDirectory() && !fs.existsSync(dst)) {
      fs.cpSync(src, dst, { recursive: true })
      console.log(`📦 Copied local Copilot extension: ${ext}`)
    }
  }
}

/**
 * If `github.copilot-chat` didn't land via the CLI install (VS Code 1.103+
 * refuses to install the marketplace VSIX over the shipped built-in), copy
 * the built-in from the VS Code install directory. No-op if chat is already
 * present or the built-in path doesn't exist.
 */
function ensureCopilotChatBuiltin(extensionsDir: string): void {
  const hasChat = fs
    .readdirSync(extensionsDir)
    .some((e) => e.startsWith('github.copilot-chat'))
  if (hasChat) return

  const builtinChat = '/usr/share/code/resources/app/extensions/copilot'
  if (!fs.existsSync(builtinChat)) {
    console.log(
      `  ⚠️ copilot-chat missing and built-in not found at ${builtinChat}`
    )
    return
  }

  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(builtinChat, 'package.json'), 'utf8')
    ) as { version: string }
    const dst = path.join(extensionsDir, `github.copilot-chat-${pkg.version}`)
    fs.cpSync(builtinChat, dst, { recursive: true })
    console.log(
      `  📦 Copied built-in copilot-chat v${pkg.version} → ${path.basename(dst)}`
    )
  } catch (err) {
    console.log(`  ⚠️ Failed to copy built-in copilot-chat: ${String(err)}`)
  }
}

/**
 * Install Mobb Tracy extension from VSIX file
 * Priority: linux VSIX > dev VSIX (includes node_modules) > standard VSIX
 */
async function installMobbExtension(extensionsDir: string): Promise<void> {
  const tracerExtDir = path.join(__dirname, '..', '..', '..')
  const allVsixFiles = fs
    .readdirSync(tracerExtDir)
    .filter((f) => f.endsWith('.vsix'))

  const linuxVsix = allVsixFiles.find((f) => f.includes('-linux'))
  const devVsix = allVsixFiles.find((f) => f.includes('-dev'))
  const standardVsix = allVsixFiles.find((f) =>
    f.match(/^mobb-ai-tracer-\d+\.\d+\.\d+\.vsix$/)
  )

  let vsixPath: string
  if (process.platform === 'linux' && linuxVsix) {
    vsixPath = path.join(tracerExtDir, linuxVsix)
    console.log(`📦 Using Linux-specific VSIX: ${linuxVsix}`)
  } else if (devVsix) {
    vsixPath = path.join(tracerExtDir, devVsix)
    console.log(`📦 Using dev VSIX (includes node_modules): ${devVsix}`)
  } else if (standardVsix) {
    vsixPath = path.join(tracerExtDir, standardVsix)
    console.log(`📦 Using standard VSIX: ${standardVsix}`)
    console.log(
      '⚠️  Warning: Standard VSIX may fail due to missing node_modules'
    )
  } else {
    throw new Error('VSIX file not found. Run "npm run package:test" first.')
  }

  // Use `code --install-extension` so the Mobb entry lands in the per-profile
  // extensions.json registry. Without that, VS Code ignores the folder even
  // though it exists on disk.
  installViaCli(vsixPath, extensionsDir)
}

/** Local adapter that derives profileDir/cliPath once per call. */
function installViaCli(vsixPathOrId: string, extensionsDir: string): void {
  const cliPath = resolveVSCodeCliPath(getVSCodeExecutablePath())
  const profileDir = path.dirname(path.dirname(extensionsDir))
  installExtensionViaCli(cliPath, vsixPathOrId, profileDir, extensionsDir)
}

/**
 * Install all required extensions (Copilot + Mobb Tracy)
 */
async function installExtensions(extensionsDir: string): Promise<void> {
  // ATTEMPT 1: install via gallery ID (exercises VS Code's gallery install
  // flow — might write different extensions.json metadata than VSIX install).
  // Falls back to VSIX-path install if this fails or COPILOT_VSIX_DIR is set.
  for (const id of ['GitHub.copilot-chat', 'GitHub.copilot']) {
    installViaCli(id, extensionsDir)
  }

  // ATTEMPT 2 (fallback): install from local VSIX files
  await installCopilotExtensions(extensionsDir)

  await installMobbExtension(extensionsDir)

  dumpExtensionsJson(extensionsDir, 'after-install')

  // ATTEMPT 3: patch extensions.json — strip the isBuiltin /
  // isApplicationScoped flags that VS Code stamps on github.copilot* after
  // contacting the marketplace, since those flags trigger the filterEnabled
  // "is disabled" path.
  patchExtensionsJsonRemoveBuiltinFlags(extensionsDir)
  dumpExtensionsJson(extensionsDir, 'after-patch')
}


async function validateExtensionInstallation(
  profileDir: string
): Promise<void> {
  console.log('🔍 Validating extension installation...')

  // First, verify VS Code settings.json has correct API URL
  // This is CRITICAL - the extension reads from VS Code settings, not just runtime.config.json
  const settingsPath = path.join(profileDir, 'User', 'settings.json')
  if (!fs.existsSync(settingsPath)) {
    throw new Error(`VS Code settings.json not found at ${settingsPath}`)
  }

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  const prodApiUrl = settings['mobbAiTracer.apiUrl']
  const devApiUrl = settings['mobbAiTracerDev.apiUrl']
  if (
    (prodApiUrl && prodApiUrl.includes('localhost:3000')) ||
    (devApiUrl && devApiUrl.includes('localhost:3000'))
  ) {
    console.log(
      `   ✅ VS Code settings verified: apiUrl=${devApiUrl || prodApiUrl}`
    )
  } else {
    throw new Error(
      `VS Code settings incorrect: apiUrl=${prodApiUrl || devApiUrl} (expected localhost:3000)`
    )
  }

  // Find extension directory
  const extensionsDir = path.join(profileDir, 'User', 'extensions')

  let extensionDir: string | null = null
  if (fs.existsSync(extensionsDir)) {
    const dirs = fs
      .readdirSync(extensionsDir)
      .filter((d) => d.toLowerCase().startsWith('mobb.mobb-ai-tracer'))
    if (dirs.length > 0) {
      extensionDir = path.join(extensionsDir, dirs[0])
      console.log(`   Found extension at: ${extensionDir}`)
    }
  }

  if (!extensionDir) {
    throw new Error(
      `Extension directory not found in ${extensionsDir}. Extension may not have been installed correctly.`
    )
  }

  // Verify critical files exist (like Cursor test does)
  const requiredFiles = ['package.json', 'out/extension.js']

  for (const file of requiredFiles) {
    const filePath = path.join(extensionDir, file)
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `Extension installation failed: ${file} not found at ${filePath}`
      )
    }
  }
  console.log(`   ✅ All required files present`)

  // Verify package.json structure
  const packageJsonPath = path.join(extensionDir, 'package.json')
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))

  // Check critical package.json fields
  if (!packageJson.publisher || !packageJson.name) {
    throw new Error(
      `Extension package.json missing publisher or name: ${JSON.stringify({
        publisher: packageJson.publisher,
        name: packageJson.name,
      })}`
    )
  }

  if (!packageJson.main) {
    throw new Error(`Extension package.json missing 'main' field`)
  }

  if (
    !packageJson.activationEvents ||
    packageJson.activationEvents.length === 0
  ) {
    throw new Error(`Extension package.json missing activationEvents`)
  }

  console.log(`   ✅ package.json structure verified`)
  console.log(`      Publisher: ${packageJson.publisher}`)
  console.log(`      Name: ${packageJson.name}`)
  console.log(`      Version: ${packageJson.version}`)
  console.log(`      Main: ${packageJson.main}`)
  console.log(
    `      Activation: ${JSON.stringify(packageJson.activationEvents)}`
  )

  // Verify runtime.config.json if it exists (test builds)
  const runtimeConfigPath = path.join(
    extensionDir,
    'out',
    'runtime.config.json'
  )
  if (fs.existsSync(runtimeConfigPath)) {
    const runtimeConfig = JSON.parse(fs.readFileSync(runtimeConfigPath, 'utf8'))
    if (!runtimeConfig.API_URL?.includes('localhost:3000')) {
      throw new Error(
        `Extension runtime.config.json incorrect: API_URL=${runtimeConfig.API_URL} (expected localhost:3000)`
      )
    }
    console.log(
      `   ✅ runtime.config.json verified: API_URL=${runtimeConfig.API_URL}`
    )
  } else {
    console.log(
      `   ℹ️  No runtime.config.json (dev build - will use VS Code settings)`
    )
  }

  console.log('✅ Extension installation validated')
}
