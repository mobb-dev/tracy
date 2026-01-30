import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as zlib from 'node:zlib'

import { expect, test } from '@playwright/test'
import AdmZip from 'adm-zip'
import type { ElectronApplication, Page } from 'playwright'
import { _electron as electron } from 'playwright'

import {
  decodeAndDecompressBase64,
  verifySQLiteMagic,
} from '../shared/compression-utils'
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

// Test configuration
const TEST_TIMEOUT = 180000 // 3 minutes per test (with buffer for AI generation)
const AI_RESPONSE_TIMEOUT = 60000 // 60 seconds for AI to respond
const UPLOAD_WAIT_TIMEOUT = 45000 // 45 seconds for upload (3x poll interval)
const EXTENSION_POLL_INTERVAL = 5000 // Extension polls for changes every 5 seconds

test.describe('Cursor Extension E2E with UI Automation', () => {
  let mockServer: MockUploadServer
  let electronApp: ElectronApplication
  let mainWindow: Page
  let testProfileDir: string
  let cursorPid: number | undefined // Store PID early for cleanup
  let hasRealAuth = false // Track if real Cursor auth was provided
  let testStartTime: number // Track test start time for timing logs

  // Initialize checkpoint tracker
  const tracker = new CheckpointTracker([
    'Cursor Installed',
    'Extension Installed',
    'Cursor Auth Configured',
    'Mock Server Running',
    'Cursor Launched',
    'AI Prompt Sent',
    'Code Generated',
    'Attribution Uploaded',
  ])

  test.beforeAll(async () => {
    // Start mock upload server
    mockServer = new MockUploadServer(3000)
    await mockServer.start()
    tracker.mark('Mock Server Running')
  })

  test.afterAll(async () => {
    await mockServer.stop()
    console.log('✅ Mock server stopped')
  })

  test.beforeEach(async () => {
    // Set test timeout using the same pattern as other Playwright tests in this repo
    test.setTimeout(TEST_TIMEOUT)

    // Create isolated test profile directory
    // Use TEST_TEMP_DIR env var or system temp directory (cross-platform)
    const tempBase = process.env.TEST_TEMP_DIR || os.tmpdir()
    testProfileDir = path.join(
      tempBase,
      `cursor-e2e-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    fs.mkdirSync(testProfileDir, { recursive: true })
    console.log(`✅ Created test profile: ${testProfileDir}`)

    // Create User/globalStorage directory structure
    const globalStorageDir = path.join(testProfileDir, 'User', 'globalStorage')
    fs.mkdirSync(globalStorageDir, { recursive: true })

    // Create VS Code settings to override API URL to point to mock server
    // This is critical! The extension reads from VS Code settings, not runtime.config.json
    // Note: Dev extension uses 'mobbAiTracerDev.*' settings, prod uses 'mobbAiTracer.*'
    // We set both to handle either build type
    const settingsPath = path.join(testProfileDir, 'User', 'settings.json')
    const testSettings = {
      // Production extension settings
      'mobbAiTracer.apiUrl': 'http://localhost:3000/graphql',
      'mobbAiTracer.webAppUrl': 'http://localhost:5173',
      // Dev extension settings (when using dev build)
      'mobbAiTracerDev.apiUrl': 'http://localhost:3000/graphql',
      'mobbAiTracerDev.webAppUrl': 'http://localhost:5173',
    }
    fs.writeFileSync(settingsPath, JSON.stringify(testSettings, null, 2))
    console.log(
      '✅ Created VS Code settings with mock server URL (both prod and dev keys)'
    )

    // Setup Cursor auth - prioritize config/env over local filesystem
    // Options (in priority order):
    // 1. CURSOR_AUTH_DIR env var pointing to directory with auth files
    // 2. CURSOR_STATE_VSCDB_B64 env var with base64-encoded state.vscdb content
    // 3. Local Cursor installation auth files (dev only)
    // 4. Empty test database (may trigger login prompt)
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
          console.log(`✅ Copied auth from CURSOR_AUTH_DIR: ${authFile}`)
          authSetup = true
          hasRealAuth = true
        }
      }
    }

    // Option 2: Base64-encoded state.vscdb from env var (for CI secrets)
    // Supports both plain and gzip-compressed base64 data
    if (!authSetup && process.env.CURSOR_STATE_VSCDB_B64) {
      const secretLength = process.env.CURSOR_STATE_VSCDB_B64.length
      console.log(
        `🔐 Found CURSOR_STATE_VSCDB_B64 env var (${secretLength} chars)`
      )

      // Decode and decompress base64-encoded SQLite database
      const stateContent = decodeAndDecompressBase64(
        process.env.CURSOR_STATE_VSCDB_B64,
        true // verbose logging
      )

      // Verify SQLite format
      if (verifySQLiteMagic(stateContent)) {
        console.log('✅ Verified SQLite database format')
      } else {
        const magicBytes = stateContent.slice(0, 16).toString('utf8')
        console.log(
          `⚠️  Warning: Data does not start with SQLite magic (got: ${magicBytes.slice(0, 20)})`
        )
      }

      const targetPath = path.join(globalStorageDir, 'state.vscdb')
      fs.writeFileSync(targetPath, stateContent)
      console.log(
        `✅ Wrote state.vscdb (${stateContent.length} bytes) to: ${targetPath}`
      )
      authSetup = true
      hasRealAuth = true
    }

    // Option 2.5: Local cursor-auth.b64 file (for local Docker testing)
    // This file is created by: npm run e2e:refresh-auth
    if (!authSetup) {
      const localAuthFile = path.join(__dirname, 'cursor-auth.b64')
      if (fs.existsSync(localAuthFile)) {
        console.log(`🔐 Found local auth file: ${localAuthFile}`)
        const base64Content = fs.readFileSync(localAuthFile, 'utf8').trim()
        console.log(
          `📦 Read ${base64Content.length} chars from cursor-auth.b64`
        )

        // Decode and decompress base64-encoded SQLite database
        const stateContent = decodeAndDecompressBase64(base64Content, true)

        // Verify SQLite format
        if (verifySQLiteMagic(stateContent)) {
          console.log('✅ Verified SQLite database format')
        } else {
          const magicBytes = stateContent.slice(0, 16).toString('utf8')
          console.log(
            `⚠️  Warning: Data does not start with SQLite magic (got: ${magicBytes.slice(0, 20)})`
          )
        }

        const targetPath = path.join(globalStorageDir, 'state.vscdb')
        fs.writeFileSync(targetPath, stateContent)
        console.log(
          `✅ Wrote state.vscdb (${stateContent.length} bytes) from local file`
        )
        authSetup = true
        hasRealAuth = true
      }
    }

    // Option 3: Local Cursor installation (dev environment only)
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
          console.log(`✅ Copied Cursor auth file: ${authFile}`)
          authSetup = true
          hasRealAuth = true
        }
      }
    }

    // Option 4: Browser-based login with credentials from env vars
    if (!authSetup && hasCredentialsInEnv()) {
      console.log('🔐 Attempting browser-based Cursor login...')
      const credentials = getCredentialsFromEnv()!
      const loginResult = await loginToCursor(
        credentials,
        testProfileDir,
        {
          headless: process.env.CURSOR_LOGIN_HEADLESS !== 'false', // Default to headless
        }
      )

      if (loginResult.success) {
        console.log(`✅ Browser login successful for: ${credentials.email}`)
        authSetup = true
        hasRealAuth = true
      } else {
        console.log(`⚠️  Browser login failed: ${loginResult.error}`)
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
        console.log('✅ Copied empty test database (no Cursor auth found)')
      } else {
        console.log(
          '⚠️  Warning: No Cursor auth available - Cursor may prompt for login'
        )
        console.log(
          '   Set CURSOR_AUTH_DIR, CURSOR_STATE_VSCDB_B64, or CURSOR_EMAIL/CURSOR_PASSWORD env vars'
        )
      }
    }

    // Find the VSIX file
    // On Linux, prefer the Linux-specific VSIX (with Linux-native modules)
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
      console.log(`📦 Found Linux-specific VSIX: ${vsixPath}`)
    } else if (standardVsix) {
      vsixPath = path.join(tracerExtDir, standardVsix)
      console.log(`📦 Found VSIX: ${vsixPath}`)
    } else {
      throw new Error(
        'VSIX file not found. Run "npm run package:test" first to create the extension package.'
      )
    }

    // Install extension by directly extracting VSIX to extensions directory
    // (CLI install method consistently times out due to long profile paths)
    // Note: Try multiple possible extension locations for cross-platform compatibility
    console.log(`📦 Installing extension via direct extraction...`)

    // On Linux, Cursor may look in different extension directories
    const possibleExtDirs = [
      path.join(testProfileDir, 'User', 'extensions'), // macOS/Windows standard
      path.join(testProfileDir, 'extensions'), // Linux alternative
    ]

    // Create all possible directories
    for (const dir of possibleExtDirs) {
      fs.mkdirSync(dir, { recursive: true })
    }

    const extensionsDir = possibleExtDirs[0] // Primary installation location

    // Extract VSIX using shared utility
    const extensionInstallDir = extractVSIX(vsixPath, extensionsDir, {
      readMetadata: true,
      verifyFiles: ['package.json', 'out/extension.js'],
      verbose: true,
    })

    // Validation: Verify extension installation succeeded
    await validateExtensionInstallation(testProfileDir, tracker)

    // Mark checkpoints
    tracker.mark('Cursor Installed')
    if (hasRealAuth) {
      tracker.mark('Cursor Auth Configured')
    }
  })

  test.afterEach(async () => {
    tracker.logTimestamp('Cleanup started (afterEach)')

    // Close Cursor - force kill immediately since graceful close hangs
    if (cursorPid) {
      try {
        process.kill(cursorPid, 'SIGKILL')
        tracker.logTimestamp(`Force killed Cursor (PID: ${cursorPid})`)
      } catch (killError) {
        // Process may have already exited - this is fine
        console.log(`ℹ️  Cursor already exited: ${killError}`)
      }
      // Wait for file handles to be released
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    // Clean up test profile directory with retry
    if (testProfileDir && fs.existsSync(testProfileDir)) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          fs.rmSync(testProfileDir, { recursive: true, force: true })
          tracker.logTimestamp('Test profile cleaned up')
          break
        } catch (cleanupError) {
          if (attempt < 2) {
            console.log(
              `⚠️  Cleanup attempt ${attempt + 1} failed, retrying...`
            )
            await new Promise((resolve) => setTimeout(resolve, 1000))
          } else {
            console.log(`⚠️  Could not clean up test profile: ${cleanupError}`)
          }
        }
      }
    }

    // Clear mock server data
    mockServer.clearAll()
    tracker.logTimestamp('Cleanup complete (afterEach)')

    // Print checkpoint summary
    tracker.printSummary()
  })

  test('should install extension and capture AI inference', async () => {
    // Start timing
    testStartTime = Date.now()
    tracker.logTimestamp('Test started')

    // Get paths
    const workspaceDir = path.join(__dirname, '..', 'shared', 'test-workspace')
    const extensionsDir = path.join(testProfileDir, 'User', 'extensions')

    // Ensure workspace is a git repository with remote (required for extension to track AI changes)
    ensureWorkspaceGitRepo(workspaceDir)

    // Determine Cursor executable path based on OS
    const cursorPath = getCursorExecutablePath()
    console.log('🖱️  Cursor executable:', cursorPath)
    console.log('📁 Extensions directory:', extensionsDir)

    // List installed extensions for debugging
    try {
      const installedExts = fs.readdirSync(extensionsDir)
      console.log('📦 Installed extensions:', installedExts)
    } catch (e) {
      console.log('⚠️  Could not list extensions:', e)
    }

    // Launch Cursor with isolated profile
    // IMPORTANT: Use --extensions-dir to explicitly tell Cursor where to find extensions
    // This is critical for Linux where the default path may differ
    // NOTE: Use --folder-uri to explicitly open as workspace folder (not just a file path)
    // This ensures vscode.workspace.workspaceFolders is populated correctly
    console.log('🚀 Launching Cursor...')
    const workspaceFolderUri = `file://${workspaceDir}`
    console.log(`📂 Opening workspace folder: ${workspaceFolderUri}`)
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
        // The mobbdev upload code reads API_URL for the GraphQL endpoint
        API_URL: 'http://localhost:3000/graphql',
        MOBB_API_URL: 'http://localhost:3000',
        MOBB_API_TOKEN: 'test-token',
        NODE_ENV: 'test',
        // CRITICAL: Disable proxy for localhost connections
        // The extension's GraphQL client uses HTTP_PROXY/HTTPS_PROXY but doesn't
        // exclude localhost by default. Setting NO_PROXY prevents proxy usage for local mock server.
        NO_PROXY: 'localhost,127.0.0.1,::1',
        no_proxy: 'localhost,127.0.0.1,::1', // lowercase variant for compatibility
        // E2E TEST FIX: Ensure Cursor is detected correctly by unsetting Claude/other IDE env vars
        CLAUDE_DESKTOP: undefined,
        ANTHROPIC_CLAUDE: undefined,
        WINDSURF_IPC_HOOK: undefined,
        WINDSURF_PID: undefined,
        // Set Cursor-specific env var to force detection
        CURSOR_SESSION_ID: 'cursor-e2e-test-session',
      },
      timeout: 60000, // 60 seconds for Cursor to launch
    })

    // Get main window and store PID for cleanup
    mainWindow = await electronApp.firstWindow()
    cursorPid = electronApp.process()?.pid
    console.log(`📍 Cursor PID: ${cursorPid}`)
    await mainWindow.waitForLoadState('domcontentloaded')
    tracker.logTimestamp('Cursor window loaded')
    tracker.mark('Cursor Launched')
    await mainWindow.screenshot({
      path: 'test-results/01-cursor-loaded.png',
    })

    // Wait for VS Code/Cursor main UI to be fully loaded
    // The monaco-workbench class indicates the editor is ready
    try {
      await mainWindow.waitForSelector('.monaco-workbench', { timeout: 10000 })
      tracker.logTimestamp('Cursor ready (workbench loaded)')
    } catch {
      console.log('⚠️  Could not detect monaco-workbench, continuing anyway...')
      await mainWindow.waitForTimeout(3000) // Fallback
      tracker.logTimestamp('Cursor ready (fallback timeout)')
    }
    await mainWindow.screenshot({
      path: 'test-results/02-cursor-ready.png',
    })

    // Extension was pre-installed in beforeEach via CLI or file extraction
    // Wait for extension to activate by checking for GraphQL requests to mock server
    console.log('⏳ Waiting for extension to activate...')
    console.log(
      `  📋 Extension polls every ${EXTENSION_POLL_INTERVAL / 1000}s for completed tool calls`
    )

    // Poll until mock server receives at least one request (extension activated)
    const activationStartTime = Date.now()
    const activationTimeout = 15000 // 15 seconds max
    while (
      mockServer.getRequestLog().length === 0 &&
      Date.now() - activationStartTime < activationTimeout
    ) {
      await mainWindow.waitForTimeout(500) // Check every 500ms
    }

    tracker.logTimestamp('Extension activation wait complete', {
      mockServerRequests: mockServer.getRequestLog().length,
      waitedMs: Date.now() - activationStartTime,
    })

    // Check if there's an "Extension Host Unresponsive" alert
    const unresponsiveAlert = await mainWindow
      .locator('text=/Extension Host Unresponsive/i')
      .count()
    if (unresponsiveAlert > 0) {
      console.log('⚠️  WARNING: Extension host unresponsive alert detected!')
      console.log('  📋 This may delay the extension polling and upload timing')
      await mainWindow.screenshot({
        path: 'test-results/error-extension-host-unresponsive.png',
      })
    } else {
      console.log('✅ Extension activated successfully')
    }

    // Now that extension is activated, open Output panel and select its channel
    // We do this AFTER activation so the output channel is registered
    console.log('📋 Opening Output panel to capture extension logs...')
    try {
      const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

      // First dismiss any active dialogs/inputs that might capture keyboard
      console.log('  Dismissing active panels to free keyboard focus...')
      await mainWindow.keyboard.press('Escape')
      await mainWindow.waitForTimeout(300)
      await mainWindow.keyboard.press('Escape')
      await mainWindow.waitForTimeout(300)

      // Click in the editor area to ensure focus is on the main window
      try {
        const editorArea = mainWindow.locator('.editor-group-container').first()
        if (await editorArea.isVisible({ timeout: 1000 })) {
          await editorArea.click()
          console.log('  Clicked editor area')
        }
      } catch {
        await mainWindow.mouse.click(600, 400)
        console.log('  Clicked at fixed position')
      }
      await mainWindow.waitForTimeout(300)

      // Open Command Palette
      console.log('  Opening Command Palette...')
      await mainWindow.keyboard.press(`${modifier}+Shift+KeyP`)
      await mainWindow.waitForTimeout(500)

      await mainWindow.screenshot({
        path: 'test-results/03-command-palette.png',
      })

      // Type command to show output channels
      await mainWindow.keyboard.type('Output: Show Output Channels')
      await mainWindow.waitForTimeout(300)
      await mainWindow.keyboard.press('Enter')
      await mainWindow.waitForTimeout(1000)

      await mainWindow.screenshot({
        path: 'test-results/04-output-quickpick.png',
      })

      // Type to filter and select Mobb AI Tracer channel
      console.log('  Searching for Mobb AI Tracer channel in quickpick...')
      await mainWindow.keyboard.type('mobb-ai-tracer')
      await mainWindow.waitForTimeout(500)

      await mainWindow.screenshot({
        path: 'test-results/05-output-filtered.png',
      })

      // Press Enter to select the first matching result
      await mainWindow.keyboard.press('Enter')
      await mainWindow.waitForTimeout(1000)

      await mainWindow.screenshot({
        path: 'test-results/06-output-panel.png',
      })

      // Copy the output content to a file for analysis
      console.log('  Copying output content...')
      try {
        // Select all content in the output panel
        await mainWindow.keyboard.press(`${modifier}+KeyA`)
        await mainWindow.waitForTimeout(200)
        // Copy to clipboard
        await mainWindow.keyboard.press(`${modifier}+KeyC`)
        await mainWindow.waitForTimeout(200)

        // Get clipboard content via Electron's clipboard API
        const clipboardContent = await electronApp.evaluate(
          async ({ clipboard }) => {
            return clipboard.readText()
          }
        )

        if (clipboardContent && clipboardContent.length > 0) {
          fs.writeFileSync(
            path.join('test-results', 'extension-output.txt'),
            clipboardContent
          )
          console.log(
            `  ✅ Saved ${clipboardContent.length} chars to extension-output.txt`
          )
        } else {
          console.log('  ⚠️  No content copied from Output panel')
        }
      } catch (copyErr) {
        console.log(`  ⚠️  Could not copy output content: ${copyErr}`)
      }

      console.log('  ✅ Selected Mobb AI Tracer output channel')
    } catch (err) {
      console.log(`  ⚠️  Could not open Output panel: ${err}`)
    }

    // Focus and activate the agent/composer window
    console.log('🤖 Sending prompt to Cursor AI agent...')
    try {
      await mainWindow.screenshot({
        path: 'test-results/07-ready-for-ai.png',
      })

      // Dismiss any popup dialogs that might be blocking
      console.log('  Dismissing popup dialogs...')

      // Dismiss Git repository dialog ("Never" button)
      try {
        const neverButton = mainWindow.locator('button:has-text("Never")')
        if (await neverButton.isVisible({ timeout: 2000 })) {
          console.log('  Found Git dialog, clicking "Never"...')
          await neverButton.click()
          await mainWindow.waitForTimeout(500)
        }
      } catch (e) {
        console.log('  No Git dialog found')
      }

      // Dismiss Cursor login dialog if it appears
      try {
        // Look for various login/sign-in buttons and dismiss them
        const loginDialogSelectors = [
          'button:has-text("Not now")',
          'button:has-text("Skip")',
          'button:has-text("Cancel")',
          'button:has-text("Close")',
          '[aria-label="Close"]',
        ]
        for (const selector of loginDialogSelectors) {
          const button = mainWindow.locator(selector).first()
          if (await button.isVisible({ timeout: 1000 })) {
            console.log(`  Found login/dialog dismiss button: ${selector}`)
            await button.click()
            await mainWindow.waitForTimeout(500)
            break
          }
        }
      } catch (e) {
        console.log('  No login dialog found')
      }

      // Press Escape to dismiss any modal dialogs
      await mainWindow.keyboard.press('Escape')
      await mainWindow.waitForTimeout(500)

      // Dismiss Agent Layout tour by pressing Escape or clicking outside
      try {
        const revertLayoutButton = mainWindow.locator(
          'button:has-text("Revert to editor layout")'
        )
        if (await revertLayoutButton.isVisible({ timeout: 1000 })) {
          console.log('  Found Agent Layout tour, dismissing with Escape...')
          await mainWindow.keyboard.press('Escape')
          await mainWindow.waitForTimeout(500)
        }
      } catch (e) {
        console.log('  No Agent Layout tour found')
      }

      // Press Escape again to dismiss any remaining dialogs
      await mainWindow.keyboard.press('Escape')
      await mainWindow.waitForTimeout(500)

      await mainWindow.screenshot({
        path: 'test-results/08-dialogs-dismissed.png',
      })

      // Dismiss any update notifications that might steal focus
      console.log('  Dismissing update notifications...')
      try {
        const laterButton = mainWindow
          .locator('button:has-text("Later")')
          .first()
        if (await laterButton.isVisible({ timeout: 2000 })) {
          console.log('  Found update notification, clicking "Later"...')
          await laterButton.click()
          await mainWindow.waitForTimeout(500)
        }
      } catch (e) {
        console.log('  No update notification found')
      }

      // Open Agent panel with Ctrl+L (or Cmd+L on macOS)
      console.log('  Opening Agent panel with keyboard shortcut...')
      const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
      await mainWindow.keyboard.press(`${modifier}+L`)
      await mainWindow.waitForTimeout(1500)

      await mainWindow.screenshot({
        path: 'test-results/09-agent-panel-opened.png',
      })

      // CRITICAL: Click directly on the chat input textarea to ensure focus
      // The input field has placeholder "Plan, @ for context, / for commands"
      console.log('  Clicking on chat input field to ensure focus...')
      const chatInputSelectors = [
        'textarea[placeholder*="Plan"]',
        'textarea[placeholder*="context"]',
        '[class*="composer"] textarea',
        '[class*="chat"] textarea',
        '[class*="aichat"] textarea',
        'div[contenteditable="true"]',
      ]

      let inputFocused = false
      for (const selector of chatInputSelectors) {
        try {
          const input = mainWindow.locator(selector).first()
          if (await input.isVisible({ timeout: 1000 })) {
            console.log(`  Found chat input with selector: ${selector}`)
            await input.click()
            await mainWindow.waitForTimeout(500)
            inputFocused = true
            break
          }
        } catch {
          // Try next selector
        }
      }

      if (!inputFocused) {
        console.log(
          '  ⚠️  Could not find chat input, trying click on placeholder text...'
        )
        // Fallback: click on the visible placeholder text area
        try {
          const placeholderArea = mainWindow
            .locator('text=Plan, @ for context')
            .first()
          if (await placeholderArea.isVisible({ timeout: 1000 })) {
            await placeholderArea.click()
            await mainWindow.waitForTimeout(500)
            inputFocused = true
          }
        } catch {
          console.log('  ⚠️  Could not click placeholder area either')
        }
      }

      await mainWindow.screenshot({
        path: 'test-results/10-agent-input-focused.png',
      })

      // Use a unique filename to ensure AI creates a NEW file (not reading an existing one)
      const uniqueId = Date.now()
      const prompt = `Create a new file called utils-${uniqueId}.js with a simple add function that adds two numbers`
      console.log(`  Typing prompt: "${prompt}"`)
      console.log(`  Input focused: ${inputFocused}`)

      // Type character by character with verification
      await mainWindow.keyboard.type(prompt, { delay: 50 })
      await mainWindow.waitForTimeout(1000)
      await mainWindow.screenshot({
        path: 'test-results/11-prompt-typed.png',
      })

      console.log('  Submitting prompt...')
      await mainWindow.keyboard.press('Enter')
      await mainWindow.waitForTimeout(2000)
      tracker.logTimestamp('Prompt submitted')
      tracker.mark('AI Prompt Sent')
      await mainWindow.screenshot({
        path: 'test-results/12-prompt-sent.png',
      })

      // Wait for AI to start generating
      console.log('⏳ Waiting for AI to start generating...')
      await mainWindow.waitForTimeout(5000) // 5 seconds for AI to start
      await mainWindow.screenshot({
        path: 'test-results/13-generation-started.png',
      })

      // Check for login/subscription prompts that indicate auth issues
      console.log('🔍 Checking for auth/subscription issues...')
      const authIssueSelectors = [
        'text=/sign in|log in|login/i',
        'text=/subscribe|subscription|upgrade/i',
        'text=/free trial|trial ended/i',
        'text=/limit reached|rate limit/i',
        'text=/authentication|authenticate/i',
      ]

      let authIssueDetected = false
      for (const selector of authIssueSelectors) {
        try {
          const element = mainWindow.locator(selector).first()
          if (await element.isVisible({ timeout: 1000 })) {
            const text = await element.textContent()
            console.log(`⚠️  Potential auth issue detected: "${text}"`)
            authIssueDetected = true
            await mainWindow.screenshot({
              path: 'test-results/error-auth-issue-detected.png',
            })
            break
          }
        } catch {
          // Selector not found, continue
        }
      }

      if (authIssueDetected) {
        console.log(
          '❌ Authentication or subscription issue detected in Cursor UI'
        )
        console.log(
          '   This likely means the auth tokens are expired or invalid'
        )
        console.log('   Try refreshing auth: npm run e2e:refresh-auth')

        // Fail fast if auth issues detected - no point waiting for AI generation
        throw new Error(
          'Cursor authentication/subscription issue detected. ' +
            'The auth tokens may be expired. Run: npm run e2e:refresh-auth'
        )
      }

      // Wait for AI generation to complete
      console.log('⏳ Waiting for AI generation to complete...')
      let generationCompleted = false
      try {
        // Try to wait for completion indicators like "Keep All" or "Undo All" buttons
        await mainWindow.waitForSelector(
          'text=/Keep All|Undo All|Accept|Reject/i',
          { timeout: AI_RESPONSE_TIMEOUT }
        )
        console.log('✅ Generation completion detected (found action buttons)')
        generationCompleted = true

        // CRITICAL: Click "Accept" to apply the AI-generated changes
        // The extension only tracks changes that are actually applied to files
        console.log('🔄 Clicking Accept to apply AI changes...')
        const acceptButton = mainWindow
          .locator('button:has-text("Accept")')
          .first()
        if (await acceptButton.isVisible({ timeout: 3000 })) {
          await acceptButton.click()
          console.log('✅ Clicked Accept button')
          await mainWindow.waitForTimeout(2000) // Wait for file to be written

          await mainWindow.screenshot({
            path: 'test-results/15-changes-accepted.png',
          })
        } else {
          console.log('⚠️  Accept button not visible, trying "Keep All"...')
          const keepAllButton = mainWindow
            .locator('button:has-text("Keep All")')
            .first()
          if (await keepAllButton.isVisible({ timeout: 2000 })) {
            await keepAllButton.click()
            console.log('✅ Clicked Keep All button')
            await mainWindow.waitForTimeout(2000)
          }
        }
      } catch (error) {
        console.log(
          '⚠️  Could not detect completion UI, waiting additional time...'
        )
        await mainWindow.waitForTimeout(10000) // Additional 10 seconds
      }

      // Check if actual code was generated (look for code blocks or file content)
      console.log('🔍 Checking if AI actually generated code...')
      const codeIndicators = [
        'pre code', // Code block
        '.monaco-editor', // Editor with generated code
        'text=/function|const|let|var|export/i', // JS code keywords
        'text=/utils-.*\\.js/i', // Our requested filename
      ]

      let codeGenerated = false
      for (const selector of codeIndicators) {
        try {
          const element = mainWindow.locator(selector).first()
          if (await element.isVisible({ timeout: 2000 })) {
            console.log(`✅ Code indicator found: ${selector}`)
            codeGenerated = true
            tracker.mark('Code Generated')
            break
          }
        } catch {
          // Continue checking
        }
      }

      if (!codeGenerated) {
        console.log('⚠️  No code generation detected in UI')
        console.log(
          '   AI may have responded with text only, or generation failed'
        )
        await mainWindow.screenshot({
          path: 'test-results/error-no-code-generated.png',
        })
      }

      // Log summary of AI generation status
      console.log('📊 AI Generation Summary:')
      console.log(`   - Auth issues detected: ${authIssueDetected}`)
      console.log(`   - Completion UI found: ${generationCompleted}`)
      console.log(`   - Code generated: ${codeGenerated}`)

      // Handle "Waiting for Approval" dialog - click Skip to bypass command execution
      // This happens when the AI agent wants to run commands like lint:fix
      console.log('  Checking for approval dialogs...')
      try {
        const skipButton = mainWindow.locator('button:has-text("Skip")').first()
        if (await skipButton.isVisible({ timeout: 3000 })) {
          console.log('  Found approval dialog, clicking Skip...')
          await skipButton.click()
          await mainWindow.waitForTimeout(2000)
        }
      } catch (e) {
        console.log('  No approval dialog found')
      }

      // Handle Extension Host Unresponsive dialog if it appears
      try {
        const reloadButton = mainWindow
          .locator('button:has-text("Reload Window")')
          .first()
        if (await reloadButton.isVisible({ timeout: 1000 })) {
          console.log(
            '⚠️  Extension Host Unresponsive detected - this may affect upload'
          )
          // Don't click reload as it would restart everything
          // Just log it for debugging
        }
      } catch (e) {
        // No dialog, which is good
      }

      await mainWindow.screenshot({
        path: 'test-results/14-generation-completed.png',
      })
      tracker.logTimestamp('AI generation completed')

      // Wait a moment for the extension to process the completion
      // The extension polls every 5 seconds for completed tool calls
      console.log('  Waiting for extension polling cycle (5s interval)...')
      await mainWindow.waitForTimeout(2000)
    } catch (error) {
      console.error('⚠️  Error during AI interaction:', error)
      console.log('📸 Taking screenshot for debugging...')
      await mainWindow.screenshot({ path: 'test-results/error-state.png' })
      throw error
    }

    // Handle upload validation based on auth availability
    if (hasRealAuth) {
      // With real auth: Wait for extension to process and upload
      // The Tracy extension polls Cursor's internal DB every 5 seconds for completed tool calls
      // Upload should happen automatically when the AI finishes generating code
      tracker.logTimestamp('Starting upload wait (real auth available)', {
        timeout: UPLOAD_WAIT_TIMEOUT,
        pollInterval: EXTENSION_POLL_INTERVAL,
        currentUploads: mockServer.getCapturedUploads().length,
        totalRequests: mockServer.getRequestLog().length,
      })

      try {
        await mockServer.waitForUploads(1, {
          timeout: UPLOAD_WAIT_TIMEOUT,
          logInterval: EXTENSION_POLL_INTERVAL, // Log every 5s to match extension poll interval
        })
        tracker.mark('Attribution Uploaded')
      } catch (uploadError) {
        // Capture debug info on timeout
        tracker.logTimestamp('Upload wait FAILED', {
          uploads: mockServer.getCapturedUploads().length,
          requests: mockServer.getRequestLog().length,
        })
        await mainWindow.screenshot({
          path: 'test-results/error-upload-timeout.png',
        })

        // Try to capture extension logs from Output panel
        console.log('📋 Capturing extension logs on failure...')
        try {
          const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
          await mainWindow.keyboard.press(`${modifier}+Shift+KeyU`)
          await mainWindow.waitForTimeout(1000)
          await mainWindow.screenshot({
            path: 'test-results/error-output-panel.png',
          })
        } catch (e) {
          console.log(`  Could not capture output panel: ${e}`)
        }

        // Capture extension host logs from Cursor's log directory
        console.log('📋 Capturing extension host logs...')
        try {
          const logsDir = path.join(testProfileDir, 'logs')
          if (fs.existsSync(logsDir)) {
            const logFiles = fs.readdirSync(logsDir, {
              recursive: true,
            }) as string[]
            console.log(`  Found ${logFiles.length} log files in ${logsDir}`)

            // Find and copy exthost logs
            for (const logFile of logFiles) {
              const logPath = path.join(logsDir, logFile)
              if (
                fs.statSync(logPath).isFile() &&
                (logFile.includes('exthost') || logFile.includes('extension'))
              ) {
                const content = fs.readFileSync(logPath, 'utf8')
                const destPath = path.join(
                  'test-results',
                  `log-${path.basename(logFile)}`
                )
                fs.writeFileSync(destPath, content)
                console.log(`  Copied ${logFile} (${content.length} chars)`)

                // Check for MOBB-TRACER logs
                if (content.includes('MOBB-TRACER')) {
                  console.log('  ✅ Found MOBB-TRACER entries in logs')
                }

                // Print key log contents to stdout for CI debugging
                if (logFile.includes('mobb-ai-tracer')) {
                  console.log(`\n📄 Contents of ${path.basename(logFile)}:`)
                  console.log('─'.repeat(60))
                  // Show FIRST 150 lines to see initial processing (important for debugging)
                  const lines = content.split('\n')
                  const firstLines = lines.slice(0, 150).join('\n')
                  console.log(firstLines)
                  if (lines.length > 150) {
                    console.log(`\n... (${lines.length - 150} more lines) ...`)
                  }
                  console.log('─'.repeat(60))
                } else if (logFile.includes('exthost.log')) {
                  console.log(`\n📄 Contents of ${path.basename(logFile)}:`)
                  console.log('─'.repeat(60))
                  // Last 50 lines for exthost errors
                  const lines = content.split('\n')
                  const lastLines = lines.slice(-50).join('\n')
                  console.log(lastLines)
                  console.log('─'.repeat(60))
                }
              }
            }
          } else {
            console.log(`  No logs directory found at ${logsDir}`)
          }
        } catch (e) {
          console.log(`  Could not capture extension host logs: ${e}`)
        }

        // Print extension-output.txt if it was captured earlier
        const extOutputPath = path.join('test-results', 'extension-output.txt')
        if (fs.existsSync(extOutputPath)) {
          const extOutput = fs.readFileSync(extOutputPath, 'utf8')
          console.log('\n📄 Contents of extension-output.txt:')
          console.log('─'.repeat(60))
          console.log(extOutput)
          console.log('─'.repeat(60))
        }

        throw uploadError
      }

      // Validate uploads
      const uploads = mockServer.getCapturedUploads()
      tracker.logTimestamp('Upload validation', {
        count: uploads.length,
        models: uploads.map((u) => u.model),
        tools: uploads.map((u) => u.tool),
      })

      // At least 1 upload expected (AI may make multiple calls for complex prompts)
      expect(uploads.length).toBeGreaterThanOrEqual(1)

      const upload = uploads[0]
      // Check session metadata that we capture from the init request
      // Model may be specific (claude/gpt/sonnet) or "default" when using Cursor's default model
      expect(upload).toMatchObject({
        tool: 'Cursor',
        model: expect.stringMatching(/claude|gpt|sonnet|default/i),
      })

      // Verify responseTime is a valid ISO timestamp
      expect(upload.responseTime).toBeTruthy()
      expect(new Date(upload.responseTime).getTime()).toBeGreaterThan(0)

      tracker.logTimestamp('All assertions passed - test complete', {
        uploads: uploads.length,
        model: upload.model,
        responseTime: upload.responseTime,
      })
    } else {
      // No real auth available
      // In CI: FAIL - we require inference uploads to validate the full flow
      // Locally: Allow infrastructure-only validation for development
      const isCI = process.env.CI === 'true'

      if (isCI) {
        // CI must have auth configured to test full inference flow
        console.log(
          '❌ CI requires Cursor authentication to test inference uploads!'
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

        // Capture logs for debugging before failing
        console.log('📋 Capturing logs for debugging...')
        try {
          const logsDir = path.join(testProfileDir, 'logs')
          if (fs.existsSync(logsDir)) {
            const logFiles = fs.readdirSync(logsDir, {
              recursive: true,
            }) as string[]
            for (const logFile of logFiles) {
              const logPath = path.join(logsDir, logFile)
              if (
                fs.statSync(logPath).isFile() &&
                (logFile.includes('exthost') ||
                  logFile.includes('mobb-ai-tracer'))
              ) {
                const content = fs.readFileSync(logPath, 'utf8')
                const destPath = path.join(
                  'test-results',
                  `log-${path.basename(logFile)}`
                )
                fs.writeFileSync(destPath, content)
                console.log(`  Copied ${logFile} (${content.length} chars)`)
              }
            }
          }
        } catch (e) {
          console.log(`  Could not capture logs: ${e}`)
        }

        throw new Error(
          'CI requires CURSOR_STATE_VSCDB_B64 secret to be configured for full inference testing. ' +
            'See logs above for setup instructions.'
        )
      }

      // Local development: Allow infrastructure-only validation
      console.log(
        'ℹ️  No real Cursor auth available - validating extension initialization only'
      )
      console.log(
        '   To test full AI inference upload, set CURSOR_AUTH_DIR or CURSOR_STATE_VSCDB_B64'
      )

      const totalRequests = mockServer.getRequestLog().length
      tracker.logTimestamp('Extension validation (no auth)', {
        totalRequests,
        requestLog: mockServer.getRequestLog(),
      })

      // Verify extension made initial requests (Me query, CreateCommunityUser, etc.)
      expect(totalRequests).toBeGreaterThan(0)
      console.log(
        `✅ Extension made ${totalRequests} GraphQL requests - infrastructure working!`
      )

      // Capture extension logs for documentation
      console.log('📋 Capturing extension host logs for verification...')
      try {
        const logsDir = path.join(testProfileDir, 'logs')
        if (fs.existsSync(logsDir)) {
          const logFiles = fs.readdirSync(logsDir, {
            recursive: true,
          }) as string[]
          for (const logFile of logFiles) {
            const logPath = path.join(logsDir, logFile)
            if (
              fs.statSync(logPath).isFile() &&
              (logFile.includes('exthost') ||
                logFile.includes('mobb-ai-tracer'))
            ) {
              const content = fs.readFileSync(logPath, 'utf8')
              const destPath = path.join(
                'test-results',
                `log-${path.basename(logFile)}`
              )
              fs.writeFileSync(destPath, content)
              console.log(`  Copied ${logFile} (${content.length} chars)`)
            }
          }
        }
      } catch (e) {
        console.log(`  Could not capture logs: ${e}`)
      }

      tracker.logTimestamp(
        'Extension validation passed - infrastructure test complete (local only)',
        {
          requestCount: totalRequests,
        }
      )
    }
  })
})
