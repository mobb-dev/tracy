import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import * as vscode from 'vscode'

/**
 * Get the VS Code "User" data directory per platform.
 *
 * Detects the VS Code variant (stable, Insiders, Cursor, Windsurf) via
 * `vscode.env.appName` and falls back through known directory names if the
 * primary detection fails (e.g., unknown variant, missing directory).
 *
 * Returns e.g. `~/Library/Application Support/Code/User` on macOS stable.
 */
export function getVSCodeUserDir(): string {
  const home = os.homedir()
  const platform = os.platform()

  let appData: string
  if (platform === 'darwin') {
    appData = path.join(home, 'Library', 'Application Support')
  } else if (platform === 'win32') {
    appData = process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming')
  } else {
    appData = process.env['XDG_CONFIG_HOME'] ?? path.join(home, '.config')
  }

  // Detect variant from vscode.env.appName, then try known directory names
  const appName = vscode.env.appName?.toLowerCase() ?? ''
  const variantDir = getVariantDir(appName)

  // Primary: detected variant directory
  const primaryDir = path.join(appData, variantDir, 'User')
  if (fs.existsSync(primaryDir)) {
    return primaryDir
  }

  // Fallback: try all known variant directories
  const fallbackDirs = ['Code', 'Code - Insiders', 'Cursor', 'Windsurf']
  for (const dir of fallbackDirs) {
    const candidate = path.join(appData, dir, 'User')
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  // Last resort: return the detected variant dir even if it doesn't exist yet
  return primaryDir
}

/** Map appName to the expected data directory name. */
function getVariantDir(appName: string): string {
  if (appName.includes('insiders')) {
    return 'Code - Insiders'
  }
  if (appName.includes('cursor')) {
    return 'Cursor'
  }
  if (appName.includes('windsurf')) {
    return 'Windsurf'
  }
  return 'Code'
}
