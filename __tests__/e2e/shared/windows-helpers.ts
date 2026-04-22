/**
 * Shared helpers for Windows E2E tests.
 * Extracted from individual Windows test files to reduce duplication.
 */

import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'

/** Claude Code hook settings type */
export type ClaudeCodeSettings = {
  hooks?: {
    PostToolUse?: Array<{
      matcher: string
      hooks: Array<{
        type: string
        command: string
      }>
    }>
  }
  [key: string]: unknown
}

/** Log the Windows environment for CI debugging */
export function logWindowsEnvironment(extra?: Record<string, string>): void {
  console.log('  ┌─────────────────────────────────────────────')
  console.log('  │ WINDOWS ENVIRONMENT')
  console.log('  ├─────────────────────────────────────────────')
  console.log(`  │ Platform:       ${process.platform}`)
  console.log(`  │ Arch:           ${process.arch}`)
  console.log(`  │ Node.js:        ${process.version}`)
  console.log(`  │ OS Release:     ${os.release()}`)
  console.log(`  │ OS Type:        ${os.type()}`)
  console.log(`  │ Hostname:       ${os.hostname()}`)
  console.log(`  │ Home Dir:       ${os.homedir()}`)
  console.log(`  │ Temp Dir:       ${os.tmpdir()}`)
  console.log(`  │ CPUs:           ${os.cpus().length}`)
  console.log(`  │ Total Memory:   ${Math.round(os.totalmem() / 1024 / 1024)} MB`)
  console.log(`  │ Free Memory:    ${Math.round(os.freemem() / 1024 / 1024)} MB`)
  console.log(`  │ Uptime:         ${Math.round(os.uptime())}s`)
  console.log(`  │ CWD:            ${process.cwd()}`)
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      console.log(`  │ ${key}: ${value}`)
    }
  }
  console.log('  └─────────────────────────────────────────────')
}

/** Log relevant environment variables (secrets redacted) */
export function logRelevantEnvVars(extraKeys?: string[]): void {
  const relevant = [
    'API_URL', 'MOBBDEV_LOCAL_CLI', 'CI', 'ENVIRONMENT',
    'AWS_DEFAULT_REGION', 'AWS_REGION', 'CLAUDE_CODE_USE_BEDROCK',
    ...(extraKeys ?? []),
  ]
  const secret = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_API_KEY']

  console.log('  ┌─────────────────────────────────────────────')
  console.log('  │ ENVIRONMENT VARIABLES')
  console.log('  ├─────────────────────────────────────────────')
  for (const key of relevant) {
    const val = process.env[key]
    if (key === 'PATH') {
      console.log(`  │ ${key}: (${val ? val.split(path.delimiter).length : 0} entries)`)
    } else {
      console.log(`  │ ${key}: ${val ?? '(not set)'}`)
    }
  }
  for (const key of secret) {
    const val = process.env[key]
    console.log(`  │ ${key}: ${val ? `***${val.slice(-4)}` : '(not set)'}`)
  }
  console.log('  └─────────────────────────────────────────────')
}

/** Check if a port is in use. Closes the probe socket on all branches. */
export async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => { server.close(); resolve(true) })
    server.once('listening', () => { server.close(); resolve(false) })
    server.listen(port)
  })
}

/** Fail the test if `port` is already bound. Call before starting MockUploadServer
 *  so collisions surface with a clear message instead of mysterious hang/flake.
 */
export async function assertPortFree(port: number): Promise<void> {
  if (await isPortInUse(port)) {
    throw new Error(
      `Port ${port} is already in use. Another MockUploadServer or stale daemon ` +
        `is bound. Free it (lsof/taskkill) before re-running, or set a different port.`
    )
  }
}

/** Log directory contents */
export function logDirectoryContents(dir: string, label: string, maxDepth = 1): void {
  console.log(`  ${label}: ${dir}`)
  if (!fs.existsSync(dir)) {
    console.log(`    (directory does not exist)`)
    return
  }
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        console.log(`    [DIR]  ${entry.name}/`)
        if (maxDepth > 1) {
          try {
            const subEntries = fs.readdirSync(fullPath).slice(0, 5)
            for (const sub of subEntries) {
              console.log(`             ${sub}`)
            }
          } catch { /* permission denied */ }
        }
      } else {
        const size = fs.statSync(fullPath).size
        console.log(`    [FILE] ${entry.name} (${size} bytes)`)
      }
    }
  } catch (err) {
    console.log(`    (error reading directory: ${err})`)
  }
}

/** Get the base directory for Windows test workspaces.
 * Uses TEST_TEMP_DIR env var if set, falls back to C:\temp.
 * IMPORTANT: Do NOT use os.tmpdir() on Windows — it resolves to a path
 * with 8.3 short names (e.g., C:\Users\RUNNER~1\...) which Claude Code
 * flags as "suspicious Windows path pattern" and denies Write tool access.
 */
export function getWindowsTempBase(): string {
  if (process.platform !== 'win32') return os.tmpdir()
  return process.env.TEST_TEMP_DIR || 'C:\\temp'
}

/** Kill a process tree on Windows using taskkill.
 * Falls back to process.kill on non-Windows platforms.
 */
export function killProcessTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'pipe' })
      console.log(`  Killed process tree (PID: ${pid})`)
    } else {
      process.kill(pid, 'SIGKILL')
      console.log(`  Killed process (PID: ${pid})`)
    }
  } catch {
    console.log(`  Process ${pid} already exited`)
  }
}
