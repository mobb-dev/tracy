import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { CheckpointTracker } from '../shared/test-utilities'

/**
 * Ensures the test workspace is a git repository with a remote.
 * Required for the extension to track AI changes.
 */
export function ensureWorkspaceGitRepo(workspaceDir: string): void {
  const gitDir = path.join(workspaceDir, '.git')
  console.log(`📁 Checking for git directory at: ${gitDir}`)
  console.log(
    `📁 Workspace contents: ${fs.readdirSync(workspaceDir).join(', ')}`
  )

  // execSync options - use /bin/bash shell explicitly for Docker compatibility
  const execOptions: Parameters<typeof execSync>[1] = {
    cwd: workspaceDir,
    stdio: 'pipe',
    shell: '/bin/bash',
  }

  if (!fs.existsSync(gitDir)) {
    console.log('📁 .git directory not found, initializing git repository...')
    try {
      execSync('git init', execOptions)
      execSync('git config user.email "test@example.com"', execOptions)
      execSync('git config user.name "Test User"', execOptions)
      // Add fake remote (required for extension to get repository info)
      execSync(
        'git remote add origin https://github.com/test-org/test-repo.git',
        execOptions
      )
      execSync('git add -A', execOptions)
      execSync(
        'git commit -m "Initial test workspace" --allow-empty',
        execOptions
      )
      console.log('✅ Git repository initialized with remote')
    } catch (gitErr) {
      console.log(`⚠️  Could not initialize git repo: ${gitErr}`)
      // Log what files exist for debugging
      console.log(
        `📁 Workspace directory exists: ${fs.existsSync(workspaceDir)}`
      )
      console.log(
        `📁 Workspace contents after error: ${fs.readdirSync(workspaceDir).join(', ')}`
      )
    }
  } else {
    console.log('📁 .git directory found, checking remote...')
    // Ensure remote exists even if git dir exists
    try {
      const remoteUrl = execSync('git remote get-url origin', execOptions)
      console.log(
        `✅ Git repository already exists with remote: ${remoteUrl.toString().trim()}`
      )
    } catch {
      console.log('📁 Adding remote to existing git repository...')
      try {
        execSync(
          'git remote add origin https://github.com/test-org/test-repo.git',
          execOptions
        )
        console.log('✅ Remote added to existing repository')
      } catch (remoteErr) {
        console.log(`⚠️  Could not add remote: ${remoteErr}`)
      }
    }
  }
}

/**
 * Downloads and installs Cursor for Linux (AppImage).
 * For macOS, provides instructions since DMG installation is manual.
 */
export function installCursorIfNeeded(): string | null {
  const { platform } = process

  if (platform === 'linux') {
    // Auto-install Cursor AppImage for Linux/CI
    const installDir = '/tmp/cursor-install'
    const appImagePath = path.join(installDir, 'cursor.AppImage')

    if (fs.existsSync(appImagePath)) {
      console.log(`📦 Using existing Cursor AppImage: ${appImagePath}`)
      return appImagePath
    }

    console.log('📥 Cursor not found. Downloading Cursor AppImage for Linux...')
    try {
      fs.mkdirSync(installDir, { recursive: true })

      // Detect architecture
      const arch = process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
      const downloadUrl = `https://api2.cursor.sh/updates/download/golden/${arch}/cursor/2.0`

      console.log(`   Downloading from: ${downloadUrl}`)
      execSync(`wget -q -O "${appImagePath}" "${downloadUrl}"`, {
        timeout: 120000,
      })
      execSync(`chmod +x "${appImagePath}"`)

      console.log(`✅ Cursor downloaded to: ${appImagePath}`)
      return appImagePath
    } catch (error) {
      console.log(`⚠️  Failed to download Cursor: ${error}`)
      return null
    }
  }

  if (platform === 'darwin') {
    console.log('ℹ️  Cursor not found on macOS.')
    console.log('   Download from: https://cursor.sh/download')
    console.log('   Or use: brew install --cask cursor')
    return null
  }

  return null
}

/**
 * Gets the Cursor executable path based on the OS platform.
 * Checks CURSOR_PATH env var first, then common installation locations.
 */
export function getCursorExecutablePath(): string {
  // Always check CURSOR_PATH env var first (works for all platforms and CI)
  if (process.env.CURSOR_PATH) {
    if (fs.existsSync(process.env.CURSOR_PATH)) {
      return process.env.CURSOR_PATH
    }
    console.log(
      `⚠️  CURSOR_PATH set to ${process.env.CURSOR_PATH} but file not found, falling back to defaults`
    )
  }

  const { platform } = process

  if (platform === 'darwin') {
    // macOS - check common locations
    const macPaths = [
      '/Applications/Cursor.app/Contents/MacOS/Cursor',
      path.join(os.homedir(), 'Applications/Cursor.app/Contents/MacOS/Cursor'),
    ]
    for (const p of macPaths) {
      if (fs.existsSync(p)) {
        return p
      }
    }
    // Try auto-install (will just provide instructions for macOS)
    const installed = installCursorIfNeeded()
    if (installed) {
      return installed
    }
    throw new Error(
      'Cursor not found. Install Cursor from https://cursor.sh/download or set CURSOR_PATH'
    )
  }

  if (platform === 'linux') {
    // Linux - check common locations (including Docker/CI paths)
    const linuxPaths = [
      '/opt/cursor/cursor.AppImage',
      '/opt/cursor/AppRun',
      '/opt/cursor/cursor',
      '/usr/local/bin/cursor',
      '/usr/bin/cursor',
      '/tmp/cursor-install/cursor.AppImage',
    ]
    for (const p of linuxPaths) {
      if (fs.existsSync(p)) {
        return p
      }
    }
    // Try auto-install for Linux
    const installed = installCursorIfNeeded()
    if (installed) {
      return installed
    }
    throw new Error(
      'Cursor not found. Set CURSOR_PATH environment variable or allow auto-download.'
    )
  }

  if (platform === 'win32') {
    // Windows - check common locations
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files'
    const localAppData = process.env['LOCALAPPDATA'] || ''
    const winPaths = [
      path.join(programFiles, 'Cursor', 'Cursor.exe'),
      path.join(localAppData, 'Programs', 'Cursor', 'Cursor.exe'),
    ]
    for (const p of winPaths) {
      if (fs.existsSync(p)) {
        return p
      }
    }
    throw new Error(
      'Cursor not found. Install Cursor or set CURSOR_PATH environment variable.'
    )
  }

  throw new Error(`Unsupported platform: ${platform}`)
}

/**
 * Validates that the extension was installed correctly by checking:
 * 1. Extension files exist in the expected location
 * 2. VS Code settings.json has correct test URLs (this is what the extension actually reads!)
 */
export async function validateExtensionInstallation(
  profileDir: string,
  tracker: CheckpointTracker
): Promise<void> {
  console.log('🔍 Validating extension installation...')

  // First, verify VS Code settings.json has correct API URL
  // This is the CRITICAL check - the extension reads from VS Code settings, not runtime.config.json
  // Note: Dev extension uses 'mobbAiTracerDev.*', prod uses 'mobbAiTracer.*'
  const settingsPath = path.join(profileDir, 'User', 'settings.json')
  if (fs.existsSync(settingsPath)) {
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
  } else {
    throw new Error(
      `VS Code settings.json not found at ${settingsPath} - extension will use production URLs!`
    )
  }

  // Find extension directory (could be installed by CLI or pre-populated)
  const extensionsDir = path.join(profileDir, 'User', 'extensions')
  const cliExtensionsDir = path.join(profileDir, 'extensions') // CLI may install here

  let extensionDir: string | null = null

  // Check both possible locations
  for (const baseDir of [extensionsDir, cliExtensionsDir]) {
    if (fs.existsSync(baseDir)) {
      const dirs = fs
        .readdirSync(baseDir)
        .filter((d) => d.toLowerCase().startsWith('mobb.mobb-ai-tracer'))
      if (dirs.length > 0) {
        extensionDir = path.join(baseDir, dirs[0])
        break
      }
    }
  }

  if (!extensionDir) {
    throw new Error(
      `Extension installation failed: Extension directory not found in ${extensionsDir} or ${cliExtensionsDir}`
    )
  }
  console.log(`   Found extension at: ${extensionDir}`)

  // Verify critical files exist
  const requiredFiles = [
    'package.json',
    'out/extension.js',
    'out/runtime.config.json',
  ]
  for (const file of requiredFiles) {
    const filePath = path.join(extensionDir, file)
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `Extension installation failed: ${file} not found at ${filePath}`
      )
    }
  }

  // Verify runtime.config.json has correct API URL
  const runtimeConfigPath = path.join(
    extensionDir,
    'out',
    'runtime.config.json'
  )
  const runtimeConfig = JSON.parse(fs.readFileSync(runtimeConfigPath, 'utf8'))
  if (!runtimeConfig.API_URL?.includes('localhost:3000')) {
    throw new Error(
      `Extension runtime.config.json incorrect: API_URL=${runtimeConfig.API_URL} (expected localhost:3000)`
    )
  }
  console.log(
    `   ✅ runtime.config.json verified: API_URL=${runtimeConfig.API_URL}`
  )
  console.log('   ✅ Critical extension files verified')

  tracker.mark('Extension Installed')
}
