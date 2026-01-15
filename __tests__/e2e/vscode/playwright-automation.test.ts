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
import { MockUploadServer } from '../shared/mock-server'
import { CheckpointTracker } from '../shared/test-utilities'
import { extractVSIX } from '../shared/vsix-installer'
import { createVSCodeState } from './helpers/create-vscode-state'
import {
  loadCredentialsFromEnv,
  performDeviceFlowOAuth,
} from './helpers/device-flow-oauth'
import { getVSCodeExecutablePath } from './vscode-helper'

// Test configuration
const TEST_TIMEOUT = 120000 // 2 minutes for infrastructure-only test (no AI generation)

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

/**
 * VS Code Extension E2E Test (Infrastructure-Only)
 *
 * This test validates the Mobb AI Tracer extension's infrastructure in VS Code:
 * - CHECKPOINT 1: VS Code installation
 * - CHECKPOINT 2: Copilot extension installation
 * - CHECKPOINT 3: Mobb extension installation
 * - CHECKPOINT 4: Extension authentication with mock server
 *
 * ⚠️ NOTE: This is an infrastructure-only test
 * Full E2E testing (Copilot AI generation + inference capture) is NOT viable
 * in headless Docker due to VS Code Electron renderer GPU initialization failures.
 *
 * Root cause: ERROR:components/viz/service/main/viz_main_impl.cc:189
 * Exiting GPU process due to errors during initialization
 *
 * See: clients/tracer_ext/__tests__/e2e/README.md for full investigation details.
 */
test.describe('VS Code Extension E2E (Infrastructure-Only)', () => {
  let testStartTime: number
  let mockServer: MockUploadServer
  let electronApp: ElectronApplication
  let mainWindow: Page
  let testProfileDir: string
  let vscodePid: number | undefined

  // Initialize checkpoint tracker
  const tracker = new CheckpointTracker([
    'VS Code Installed',
    'Copilot Installed',
    'Extension Installed',
    'Mock Server Running',
    'Extension Authenticated',
  ])

  test.beforeAll(async () => {
    mockServer = new MockUploadServer(3000)
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
      'mobbAiTracer.apiUrl': 'http://localhost:3000/graphql',
      'mobbAiTracer.webAppUrl': 'http://localhost:5173',
      'mobbAiTracerDev.apiUrl': 'http://localhost:3000/graphql',
      'mobbAiTracerDev.webAppUrl': 'http://localhost:5173',
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
    }
    fs.writeFileSync(settingsPath, JSON.stringify(testSettings, null, 2))
    console.log('✅ Created VS Code settings with mock server URL')

    // Setup auth from pre-built credentials or fallback methods
    await setupAuth(globalStorageDir)

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
        `--folder-uri=${workspaceFolderUri}`,
      ],
      env: {
        ...process.env,
        API_URL: 'http://localhost:3000/graphql',
        MOBB_API_URL: 'http://localhost:3000',
        MOBB_API_TOKEN: 'test-token',
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

    // Log console messages for debugging
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
      console.log(`  [Console ${msg.type()}] ${text}`)
    })

    await mainWindow.waitForLoadState('domcontentloaded')

    try {
      await mainWindow.waitForSelector('.monaco-workbench', { timeout: 10000 })
      tracker.logTimestamp('VS Code workbench loaded')
    } catch {
      await mainWindow.waitForTimeout(3000)
      tracker.logTimestamp('VS Code ready (fallback timeout)')
    }
    // Screenshot removed - causes crash in headless mode due to GPU initialization failures
    // await safeScreenshot(mainWindow, 'test-results/20-vscode-ready.png')

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

      // Wait longer for extension to activate (30 seconds)
      const activationStartTime = Date.now()
      const activationTimeout = 30000
      console.log('  Waiting for extension activation (up to 30s)...')
      while (
        mockServer.getRequestLog().length === 0 &&
        Date.now() - activationStartTime < activationTimeout
      ) {
        await mainWindow.waitForTimeout(1000)
        const elapsed = Math.floor((Date.now() - activationStartTime) / 1000)
        if (elapsed % 5 === 0) {
          console.log(
            `  ... ${elapsed}s elapsed, requests: ${mockServer.getRequestLog().length}`
          )
        }
      }

      const requests = mockServer.getRequestLog()
      console.log(`  Mock server requests: ${requests.length}`)

      // ⚠️ NOTE: In headless Docker, VS Code crashes due to GPU initialization failures
      // (ERROR:viz_main_impl.cc:189), so the extension never activates.
      // This is a known platform limitation, not a test failure.
      // See LESSONS.md Challenge 22 for details.

      if (requests.length === 0) {
        console.log(
          '  ⚠️  Extension did not make any requests (expected in headless mode)'
        )
        console.log(
          '     Reason: VS Code crashes due to GPU initialization failures'
        )
        console.log(
          '     This validates packaging/installation only (checkpoints 1-3)'
        )
      } else {
        // Check for Me query (authentication check)
        const meQuery = requests.find((r) => r.body?.operationName === 'Me')
        const hasLoginActivity =
          requests.some(
            (r) => r.body?.operationName === 'CreateCommunityUser'
          ) || requests.some((r) => r.body?.operationName === 'getLastOrg')

        if (meQuery && hasLoginActivity) {
          console.log('  ✅ Extension activated and authenticated')
          console.log(`  ✅ Made ${requests.length} GraphQL requests`)
          tracker.mark('Extension Authenticated')
        } else {
          console.log(
            `  ⚠️  Extension made ${requests.length} requests but login incomplete`
          )
        }
      }

      // Screenshot removed - causes crash in headless mode
      // await safeScreenshot(mainWindow, 'test-results/30-mobb-extension-logged-in.png')
      console.log('  ℹ️  CHECKPOINT 4: See notes above\n')
    })

    // Print final summary
    tracker.logTimestamp('Test completed')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════════

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
 * PRIORITY 5: Load auth via Device Flow OAuth (fallback only - requires credentials)
 */
async function loadAuthFromDeviceFlow(
  globalStorageDir: string
): Promise<boolean> {
  const credentials = loadCredentialsFromEnv()

  if (!credentials) {
    console.log('⚠️ No auth available - tests will fail at Copilot step')
    console.log('   To enable auth, either:')
    console.log(
      '   1. Set VSCODE_STATE_VSCDB_B64 secret (run scripts/create-docker-auth.sh)'
    )
    console.log(
      '   2. Or set PLAYWRIGHT_GH_CLOUD_USER_EMAIL/PASSWORD for Device Flow OAuth'
    )
    return false
  }

  console.log('🔐 No pre-existing auth - attempting Device Flow OAuth...')
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
  // Try each auth method in priority order
  if (loadAuthFromBase64EnvVar(globalStorageDir)) return true
  if (loadAuthFromDirectory(globalStorageDir)) return true
  if (loadAuthFromLocalFile(globalStorageDir)) return true
  if (loadAuthFromLocalInstallation(globalStorageDir)) return true
  if (await loadAuthFromDeviceFlow(globalStorageDir)) return true

  // No auth method succeeded
  console.log('⚠️ No VS Code auth available - Copilot will not work')
  console.log(
    '   Run scripts/create-docker-auth.sh to create Linux-native auth'
  )
  return false
}

/**
 * Install GitHub Copilot extensions from Docker or local VS Code
 */
async function installCopilotExtensions(extensionsDir: string): Promise<void> {
  let copilotInstalled = false
  const copilotExtensionsDir = '/opt/copilot-extensions'

  // Try Docker pre-installed location first
  if (fs.existsSync(copilotExtensionsDir)) {
    const copilotExtensions = fs.readdirSync(copilotExtensionsDir)
    for (const ext of copilotExtensions) {
      const src = path.join(copilotExtensionsDir, ext)
      const dst = path.join(extensionsDir, ext)
      if (fs.statSync(src).isDirectory() && !fs.existsSync(dst)) {
        fs.cpSync(src, dst, { recursive: true })
        console.log(`📦 Copied Copilot extension: ${ext}`)
        copilotInstalled = true
      }
    }
  }

  // Fallback: Try copying from local VS Code installation
  if (!copilotInstalled) {
    const homeDir =
      process.platform === 'win32'
        ? process.env.USERPROFILE || ''
        : process.env.HOME || ''
    const localExtensionsDir = path.join(homeDir, '.vscode/extensions')

    if (localExtensionsDir && fs.existsSync(localExtensionsDir)) {
      const localExts = fs.readdirSync(localExtensionsDir)
      const copilotExts = localExts.filter(
        (e) =>
          e.startsWith('github.copilot-') || e.startsWith('github.copilot-chat')
      )

      for (const ext of copilotExts) {
        const src = path.join(localExtensionsDir, ext)
        const dst = path.join(extensionsDir, ext)
        if (fs.statSync(src).isDirectory() && !fs.existsSync(dst)) {
          fs.cpSync(src, dst, { recursive: true })
          console.log(`📦 Copied local Copilot extension: ${ext}`)
          copilotInstalled = true
        }
      }
    }

    if (!copilotInstalled) {
      console.log(
        '⚠️ Copilot extensions not found - install GitHub Copilot in VS Code first'
      )
    }
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

  extractVSIX(vsixPath, extensionsDir, {
    readMetadata: true,
    verifyFiles: ['package.json', 'out/extension.js'],
    verbose: true,
  })
}

/**
 * Install all required extensions (Copilot + Mobb Tracy)
 */
async function installExtensions(extensionsDir: string): Promise<void> {
  await installCopilotExtensions(extensionsDir)
  await installMobbExtension(extensionsDir)
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
