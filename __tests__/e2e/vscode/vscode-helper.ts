import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Gets the VS Code executable path based on the platform.
 * Checks VSCODE_PATH env var first, then common installation locations.
 */
export function getVSCodeExecutablePath(): string {
  // Always check VSCODE_PATH env var first (works for all platforms and CI)
  if (process.env.VSCODE_PATH) {
    if (fs.existsSync(process.env.VSCODE_PATH)) {
      return process.env.VSCODE_PATH
    }
    console.log(
      `Warning: VSCODE_PATH set to ${process.env.VSCODE_PATH} but file not found, falling back to defaults`
    )
  }

  const { platform } = process

  if (platform === 'darwin') {
    // macOS - check common locations
    const macPaths = [
      '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
      path.join(
        os.homedir(),
        'Applications/Visual Studio Code.app/Contents/MacOS/Electron'
      ),
    ]
    for (const p of macPaths) {
      if (fs.existsSync(p)) {
        return p
      }
    }
    throw new Error(
      'VS Code not found on macOS. Install VS Code from https://code.visualstudio.com/ or set VSCODE_PATH'
    )
  }

  if (platform === 'linux') {
    // Linux - check common locations
    const linuxPaths = [
      '/opt/vscode/code', // Extracted tarball (Docker)
      '/usr/share/code/code', // APT/DEB installation
      '/usr/bin/code', // Symlink
      '/snap/bin/code', // Snap installation
      '/opt/visual-studio-code/code', // Alternative extracted location
    ]
    for (const p of linuxPaths) {
      if (fs.existsSync(p)) {
        return p
      }
    }
    throw new Error(
      'VS Code not found on Linux. Set VSCODE_PATH environment variable or install VS Code.'
    )
  }

  if (platform === 'win32') {
    // Windows - check common locations
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files'
    const localAppData = process.env['LOCALAPPDATA'] || ''
    const winPaths = [
      path.join(programFiles, 'Microsoft VS Code', 'Code.exe'),
      path.join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    ]
    for (const p of winPaths) {
      if (fs.existsSync(p)) {
        return p
      }
    }
    throw new Error(
      'VS Code not found on Windows. Install VS Code or set VSCODE_PATH environment variable.'
    )
  }

  throw new Error(`Unsupported platform: ${platform}`)
}

/**
 * Gets the local VS Code global storage path for auth export.
 */
export function getVSCodeGlobalStoragePath(): string {
  const { platform } = process
  const homedir = os.homedir()

  if (platform === 'darwin') {
    return path.join(
      homedir,
      'Library/Application Support/Code/User/globalStorage'
    )
  }

  if (platform === 'linux') {
    // Check both common locations
    const paths = [
      path.join(homedir, '.config/Code/User/globalStorage'),
      path.join(homedir, '.config/code/User/globalStorage'),
    ]
    for (const p of paths) {
      if (fs.existsSync(p)) {
        return p
      }
    }
    // Return default even if it doesn't exist
    return paths[0]
  }

  if (platform === 'win32') {
    return path.join(process.env['APPDATA'] || '', 'Code/User/globalStorage')
  }

  throw new Error(`Unsupported platform: ${platform}`)
}

/**
 * Checks if VS Code auth credentials are available in environment.
 * For VS Code + Copilot, we use state.vscdb export (same as Cursor).
 */
export function hasVSCodeAuthInEnv(): boolean {
  return Boolean(
    process.env.VSCODE_STATE_VSCDB_B64 ||
      process.env.VSCODE_AUTH_DIR ||
      process.env.GITHUB_TOKEN
  )
}

/**
 * Information about a VS Code installation.
 */
export type VSCodeInfo = {
  executablePath: string
  globalStoragePath: string
  stateDbPath: string
}

/**
 * Gets information about the local VS Code installation.
 */
export function getLocalVSCodeInfo(): VSCodeInfo | null {
  try {
    const globalStoragePath = getVSCodeGlobalStoragePath()
    const stateDbPath = path.join(globalStoragePath, 'state.vscdb')

    if (!fs.existsSync(stateDbPath)) {
      console.log(`VS Code state.vscdb not found at: ${stateDbPath}`)
      return null
    }

    return {
      executablePath: getVSCodeExecutablePath(),
      globalStoragePath,
      stateDbPath,
    }
  } catch (error) {
    console.log(`Could not get VS Code info: ${error}`)
    return null
  }
}
