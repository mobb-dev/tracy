/**
 * Test Profile Utilities for E2E Tests
 *
 * Shared utilities for creating and managing test profiles across IDE tests.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Settings configuration for test environments
 */
export interface TestSettings {
  /** Include Copilot-specific settings (for VS Code tests) */
  includeCopilotSettings?: boolean
  /** Custom API URL (defaults to http://localhost:3000/graphql) */
  apiUrl?: string
  /** Custom web app URL (defaults to http://localhost:5173) */
  webAppUrl?: string
  /** Additional custom settings to merge */
  additionalSettings?: Record<string, unknown>
}

/**
 * Create a test settings.json file with mock server URLs
 */
export function createTestSettings(
  profileDir: string,
  options: TestSettings = {}
): void {
  const {
    includeCopilotSettings = false,
    apiUrl = 'http://localhost:3000/graphql',
    webAppUrl = 'http://localhost:5173',
    additionalSettings = {},
  } = options

  const settingsPath = path.join(profileDir, 'User', 'settings.json')

  const baseSettings = {
    // Production extension settings
    'mobbAiTracer.apiUrl': apiUrl,
    'mobbAiTracer.webAppUrl': webAppUrl,
    // Dev extension settings (when using dev build)
    'mobbAiTracerDev.apiUrl': apiUrl,
    'mobbAiTracerDev.webAppUrl': webAppUrl,
  }

  // Add Copilot-specific settings if requested
  const copilotSettings = includeCopilotSettings
    ? {
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
    : {}

  const testSettings = {
    ...baseSettings,
    ...copilotSettings,
    ...additionalSettings,
  }

  fs.writeFileSync(settingsPath, JSON.stringify(testSettings, null, 2))

  const settingsType = includeCopilotSettings ? ' (with Copilot settings)' : ''
  console.log(`✅ Created VS Code settings with mock server URL${settingsType}`)
}

/**
 * Create an isolated test profile directory structure
 */
export function createTestProfile(baseName: string): string {
  const tempBase = process.env.TEST_TEMP_DIR || os.tmpdir()
  const testProfileDir = path.join(
    tempBase,
    `${baseName}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )

  // Create directory structure
  fs.mkdirSync(testProfileDir, { recursive: true })

  // Create User/globalStorage directory
  const globalStorageDir = path.join(testProfileDir, 'User', 'globalStorage')
  fs.mkdirSync(globalStorageDir, { recursive: true })

  console.log(`✅ Created test profile: ${testProfileDir}`)
  return testProfileDir
}

/**
 * Find the installed Mobb AI Tracer extension directory
 */
export function findExtensionDirectory(
  profileDir: string,
  checkAlternativeLocations = false
): string | null {
  const possibleLocations = [path.join(profileDir, 'User', 'extensions')]

  // Some IDEs (like Cursor) may install extensions via CLI to a different location
  if (checkAlternativeLocations) {
    possibleLocations.push(path.join(profileDir, 'extensions'))
  }

  for (const baseDir of possibleLocations) {
    if (!fs.existsSync(baseDir)) {
      continue
    }

    const dirs = fs
      .readdirSync(baseDir)
      .filter((d) => d.toLowerCase().startsWith('mobb.mobb-ai-tracer'))

    if (dirs.length > 0) {
      return path.join(baseDir, dirs[0])
    }
  }

  return null
}

/**
 * Verify that required files exist in the extension directory
 */
export function verifyExtensionFiles(
  extensionDir: string,
  requiredFiles: string[]
): void {
  for (const file of requiredFiles) {
    const filePath = path.join(extensionDir, file)
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `Extension installation failed: ${file} not found at ${filePath}`
      )
    }
  }
  console.log(`   ✅ All required files present`)
}

/**
 * Clean up test profile directory with retries
 */
export async function cleanupTestProfile(
  testProfileDir: string,
  maxRetries = 3
): Promise<void> {
  if (!testProfileDir || !fs.existsSync(testProfileDir)) {
    return
  }

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      fs.rmSync(testProfileDir, { recursive: true, force: true })
      console.log('✅ Test profile cleaned up')
      return
    } catch (cleanupError) {
      if (attempt < maxRetries - 1) {
        console.log(`⚠️  Cleanup attempt ${attempt + 1} failed, retrying...`)
        await new Promise((resolve) => setTimeout(resolve, 1000))
      } else {
        console.log(`⚠️  Could not clean up test profile: ${cleanupError}`)
      }
    }
  }
}
