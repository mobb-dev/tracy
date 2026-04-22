/**
 * Shared profile-setup helpers for the VS Code E2E tests (Linux + Windows).
 *
 * These helpers previously lived as near-duplicates in both
 * `vscode/playwright-automation.test.ts` and
 * `vscode/playwright-automation.windows.test.ts`. Consolidating them here
 * prevents drift when a workaround in one side needs updating.
 */

import { execSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import Database from 'better-sqlite3'

import type { TracyRecord } from './mock-server'
import type { MockUploadServer } from './mock-server'

/** Dump extensions.json to stdout with a label (diagnostic). */
export function dumpExtensionsJson(
  extensionsDir: string,
  label: string
): void {
  try {
    const jsonPath = path.join(extensionsDir, 'extensions.json')
    if (fs.existsSync(jsonPath)) {
      console.log(`  extensions.json (${label}):`)
      console.log(fs.readFileSync(jsonPath, 'utf8').slice(0, 6000))
    }
  } catch (err) {
    console.log(`  could not read extensions.json (${label}): ${err}`)
  }
}

/** Strip `isBuiltin` / `isApplicationScoped` flags from `github.copilot*`
 * entries. VS Code 1.116+ stamps these on installed Copilot extensions and
 * then refuses to enable side-loaded copies; removing them lets the CLI
 * install actually activate.
 *
 * Throws on JSON parse / write failure — the patch is load-bearing for
 * CHECKPOINT 5-8 and silent failure has already cost us one diagnostic round.
 */
export function patchExtensionsJsonRemoveBuiltinFlags(
  extensionsDir: string
): void {
  const jsonPath = path.join(extensionsDir, 'extensions.json')
  if (!fs.existsSync(jsonPath)) return

  const entries = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as Array<{
    identifier?: { id?: string }
    metadata?: Record<string, unknown>
  }>

  let changed = false
  for (const entry of entries) {
    const id = entry.identifier?.id?.toLowerCase() ?? ''
    if (id.startsWith('github.copilot') && entry.metadata) {
      if (entry.metadata.isBuiltin !== undefined) {
        delete entry.metadata.isBuiltin
        changed = true
      }
      if (entry.metadata.isApplicationScoped !== undefined) {
        delete entry.metadata.isApplicationScoped
        changed = true
      }
    }
  }
  if (changed) {
    fs.writeFileSync(jsonPath, JSON.stringify(entries))
    console.log(
      '  Patched extensions.json: removed isBuiltin/isApplicationScoped from github.copilot*'
    )
  }
}

/** Force-enable Copilot + Copilot Chat in state.vscdb via the VS Code
 * ExtensionEnablementService keys. Overrides the implicit disable VS Code
 * 1.116 applies to side-loaded copies.
 */
export function forceEnableCopilotInStateDb(stateVscdbPath: string): void {
  if (!fs.existsSync(stateVscdbPath)) {
    console.log(`  forceEnable skipped — no state.vscdb at ${stateVscdbPath}`)
    return
  }
  const db = new Database(stateVscdbPath)
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value BLOB)`
    )
    const enabled = [
      { id: 'GitHub.copilot', uuid: '23c4aeee-f844-43cd-b53e-1113e483f1a6' },
      {
        id: 'GitHub.copilot-chat',
        uuid: '7ec7d6e6-b89e-4cc5-a59b-d6c4d238246f',
      },
    ]
    const setKey = (k: string, v: string) => {
      db.prepare(
        'INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)'
      ).run(k, v)
    }
    setKey('extensionsIdentifiers/global-enabled', JSON.stringify(enabled))
    setKey('extensionsIdentifiers/global-disabled', JSON.stringify([]))
    setKey('extensionsIdentifiers/enabled', JSON.stringify(enabled))
    setKey('extensionsIdentifiers/disabled', JSON.stringify([]))
    console.log(
      '  Wrote extensionsIdentifiers/global-enabled for Copilot + Copilot Chat'
    )
  } finally {
    db.close()
  }
}

/** Resolve the `code` CLI wrapper next to the VS Code Electron binary.
 * Using the CLI wrapper (rather than the Electron binary directly) makes
 * `--install-extension` run headless and exit when done.
 */
export function resolveVSCodeCliPath(electronPath: string): string {
  const dir = path.dirname(electronPath)
  const candidates =
    process.platform === 'win32'
      ? [path.join(dir, 'bin', 'code.cmd'), path.join(dir, 'bin', 'code')]
      : [
          path.join(dir, 'bin', 'code'),
          '/usr/bin/code',
          '/usr/share/code/bin/code',
        ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  console.log(
    `  WARNING: no code CLI wrapper found near ${electronPath} — falling back to Electron binary (may hang)`
  )
  return electronPath
}

/** Install a single extension via `code --install-extension <vsix>`.
 *
 * Implementation note — Windows + Node 20+:
 *   `spawnSync` cannot invoke a .cmd/.bat file directly any more (CVE-2024-27980
 *   tightened this; direct invocation returns EINVAL). When `cliPath` ends in
 *   `.cmd` we route through `cmd.exe /c <cli> <args>` with an argv array — no
 *   shell string interpolation, so the injection surface stays closed.
 */
export function installExtensionViaCli(
  cliPath: string,
  vsixPathOrId: string,
  profileDir: string,
  extensionsDir: string
): void {
  const cliArgs = [
    `--user-data-dir=${profileDir}`,
    `--extensions-dir=${extensionsDir}`,
    '--install-extension',
    vsixPathOrId,
    '--force',
  ]
  const isWindowsCmd =
    process.platform === 'win32' && cliPath.toLowerCase().endsWith('.cmd')
  const command = isWindowsCmd ? 'cmd.exe' : cliPath
  const args = isWindowsCmd ? ['/c', cliPath, ...cliArgs] : cliArgs

  console.log(`  Installing via CLI: ${path.basename(vsixPathOrId)}`)
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    timeout: 180_000,
  })
  if (result.error) {
    console.log(
      `  Install failed for ${path.basename(vsixPathOrId)}: ${result.error}`
    )
  } else if (result.status !== 0) {
    console.log(
      `  Install for ${path.basename(vsixPathOrId)} exited with status ${result.status}`
    )
  }
}

/** Decode the rawData JSON a Copilot tracy record uploaded to the mock S3.
 * Copilot rawData shape: { request: { requestId, … }, metadata: { sessionId, … } }
 */
export function decodeCopilotRawData(
  record: TracyRecord,
  server: MockUploadServer
): {
  request: { requestId: string; modelId?: string; timestamp?: number }
  metadata: { sessionId: string; workspaceRepos?: unknown }
} {
  if (!record.rawDataS3Key) {
    throw new Error('record has no rawDataS3Key')
  }
  const s3Uploads = server.getS3Uploads()
  const s3Content = s3Uploads.get(record.rawDataS3Key)
  if (!s3Content) {
    throw new Error(`S3 upload not found for key: ${record.rawDataS3Key}`)
  }
  return JSON.parse(s3Content)
}

/** Initialise a git repo for the test workspace. Uses `git` directly with
 * argv-style calls (no shell) so path/name interpolation is injection-safe.
 */
export function initTestGitRepo(workspaceDir: string): void {
  const gitDir = path.join(workspaceDir, '.git')
  if (fs.existsSync(gitDir)) return

  const run = (args: string[]) => {
    const res = spawnSync('git', args, { cwd: workspaceDir, stdio: 'pipe' })
    if (res.status !== 0) {
      throw new Error(
        `git ${args.join(' ')} exited ${res.status}: ${res.stderr?.toString() ?? ''}`
      )
    }
  }

  try {
    run(['init'])
    run(['config', 'user.email', 'test@example.com'])
    run(['config', 'user.name', 'Test User'])
    run([
      'remote',
      'add',
      'origin',
      'https://github.com/test-org/test-repo.git',
    ])
    // A failed add/commit must not abort the test; the previous steps are
    // what matter for repo identity.
    spawnSync('git', ['add', '-A'], { cwd: workspaceDir, stdio: 'pipe' })
    spawnSync(
      'git',
      ['commit', '-m', 'Initial test workspace', '--allow-empty'],
      { cwd: workspaceDir, stdio: 'pipe' }
    )
  } catch (err) {
    // Surface init/config failures immediately — the later commit failure
    // is benign (empty tree) but these are not.
    throw new Error(`Could not initialize test git repo: ${err}`)
  }
}

/** @deprecated kept for transitional call sites — prefer initTestGitRepo. */
export function ensureWorkspaceGitRepo(workspaceDir: string): void {
  try {
    initTestGitRepo(workspaceDir)
  } catch (err) {
    // Match previous behaviour where the combined try/catch swallowed everything
    console.log(`  Could not initialize git repo: ${err}`)
  }
}

/** For tests that prefer execSync (legacy call sites). Does NOT use a shell
 * to avoid command-injection surface on Windows. */
export function execGitNoShell(cwd: string, args: string[]): void {
  execSync(`git ${args.map((a) => JSON.stringify(a)).join(' ')}`, {
    cwd,
    stdio: 'pipe',
  })
}
