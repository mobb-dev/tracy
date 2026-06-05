/**
 * Create VS Code state.vscdb with a GitHub OAuth session.
 *
 * Modern VS Code (≥1.123) reads the GitHub auth session from its **secret
 * store**, not the legacy plaintext `github.auth.sessions` ItemTable key:
 *
 *   secret://{"extensionId":"vscode.github-authentication","key":"github.auth"}
 *
 * When VS Code is launched with `--password-store=basic`, that secret value is
 * the Electron/Chromium "basic" (v10) AES-128-CBC blob, stored in ItemTable as
 * a `{"type":"Buffer","data":[…]}` JSON. We reproduce exactly that so an
 * injected Device-Flow token actually authenticates Copilot — independent of
 * VS Code version and with no captured-DB dependency.
 */

import * as crypto from 'crypto'

import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'

// GitHub OAuth scopes the session declares. VS Code's github-authentication
// provider returns a stored session to a consumer (Copilot, core) only when the
// session's scopes satisfy the requested scope set, so these MUST match what
// VS Code itself requests on a real sign-in. Verified against a known-good
// captured session (auth/vscode-auth-linux.b64): the working set is
// read:user / user:email / repo / workflow — NOT a "copilot" scope (which VS
// Code never requests, so a session declaring it is never matched → "Got 0
// sessions"). Keep in sync with OAUTH_SCOPES in device-code-api.ts.
const COPILOT_SCOPES = ['read:user', 'user:email', 'repo', 'workflow']

// Secret-store key VS Code's github-authentication provider reads sessions from.
const GITHUB_SESSION_SECRET_KEY =
  'secret://{"extensionId":"vscode.github-authentication","key":"github.auth"}'

type GitHubSession = {
  id: string
  accessToken: string
  account: { label: string; id: string }
  scopes: string[]
}

/**
 * Encrypt with the Electron safeStorage "basic" scheme (what
 * `--password-store=basic` uses on every platform): "v10" prefix +
 * AES-128-CBC, key = PBKDF2-SHA1("peanuts","saltysalt",1,16), IV = 16×0x20.
 * Platform-agnostic, so a value written here decrypts on the Windows runner.
 */
function encryptBasicV10(plaintext: string): Buffer {
  const key = crypto.pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1')
  const iv = Buffer.alloc(16, 0x20) // 16 spaces
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([Buffer.from('v10', 'utf8'), enc])
}

/** VS Code stores secret values in ItemTable as `{"type":"Buffer","data":[…]}`. */
function toItemTableBufferJSON(buf: Buffer): string {
  return JSON.stringify({ type: 'Buffer', data: Array.from(buf) })
}

/**
 * Copilot "setup"/opt-in markers so the "Sign in to use AI Features" /
 * onboarding modal doesn't block generation once the session is present. The
 * entitlement (`copilot_for_business_seat_quota`) matches the Device-Flow test
 * account; VS Code refreshes these from the entitlement API once signed in, so
 * exact values aren't load-bearing — they just keep the first launch unblocked.
 */
function optInMarkers(): Array<[string, string]> {
  return [
    [
      'chat.setupContext',
      JSON.stringify({
        entitlement: 8,
        sku: 'copilot_for_business_seat_quota',
        installed: true,
        disabled: false,
        untrusted: false,
        disabledInWorkspace: false,
        registered: true,
        hidden: false,
        completed: true,
      }),
    ],
    ['chat.setupContext.migrated.v1', 'true'],
    ['chat.usageBasedBilling', 'true'],
    [
      'workbench.panel.chat.hidden',
      JSON.stringify([
        { id: 'workbench.panel.chat.view.copilot', isHidden: false },
      ]),
    ],
  ]
}

/**
 * Create a VS Code state.vscdb with a GitHub OAuth session in the secret store.
 *
 * @param accessToken GitHub OAuth access token (gho_ / ghu_ format)
 * @param outputPath Path to write the state.vscdb file
 * @param accountInfo Optional account info (fetched from GitHub if not provided)
 */
export async function createVSCodeState(
  accessToken: string,
  outputPath: string,
  accountInfo?: { login: string; id: number }
): Promise<void> {
  let account = accountInfo
  if (!account) {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github.v3+json',
      },
    })
    if (response.ok) {
      const userData = (await response.json()) as { login: string; id: number }
      account = { login: userData.login, id: userData.id }
      console.log(`[CreateState] Fetched GitHub user: ${account.login}`)
    } else {
      account = { login: 'github-user', id: 0 }
      console.log('[CreateState] Using placeholder account info')
    }
  }

  const session: GitHubSession = {
    id: `${Date.now()}`,
    accessToken,
    account: { label: account.login, id: String(account.id) },
    scopes: COPILOT_SCOPES,
  }

  // The github-authentication provider persists an ARRAY of sessions; the
  // secret value (decrypted) is JSON.stringify(sessions[]).
  const sessionsJson = JSON.stringify([session])
  const secretValue = toItemTableBufferJSON(encryptBasicV10(sessionsJson))

  const outputDir = path.dirname(outputPath)
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })

  const db = new Database(outputPath)
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value BLOB)'
    )
    const insert = db.prepare(
      'INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)'
    )

    // The session in the secret store (what ≥1.123 reads). Portable v10 here is
    // readable on Linux (basic/peanuts); on Windows VS Code does its own sign-in
    // (see native-signin.ts), so this helper is only the Linux PAT/device-flow
    // fallback path.
    insert.run(GITHUB_SESSION_SECRET_KEY, secretValue)
    // Opt-in markers so the AI-features setup gate doesn't block.
    for (const [k, v] of optInMarkers()) insert.run(k, v)
    insert.run('vscode.extensionGlobalState.version', '1')

    console.log(`[CreateState] Wrote secret-store session at: ${outputPath}`)
    console.log(`[CreateState] Account: ${account.login} (${account.id})`)
    console.log(`[CreateState] Secret key: ${GITHUB_SESSION_SECRET_KEY}`)
  } finally {
    db.close()
  }
}

/**
 * Write ONLY the Copilot setup/opt-in markers into an existing (or new)
 * state.vscdb, without touching the GitHub session. Used by the Windows native
 * sign-in flow, where VS Code stores the session itself but the fresh sign-in
 * lacks the "setup completed" markers that a pre-onboarded (captured) session
 * carries — without them, Copilot Chat shows the first-use setup gate and never
 * produces a real completion (only [title]/[progressMessages] scaffolding).
 */
export function writeCopilotSetupMarkers(outputPath: string): void {
  const outputDir = path.dirname(outputPath)
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })
  const db = new Database(outputPath)
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value BLOB)'
    )
    const insert = db.prepare(
      'INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)'
    )
    for (const [k, v] of optInMarkers()) insert.run(k, v)
    insert.run('vscode.extensionGlobalState.version', '1')
    console.log(`[CreateState] Wrote Copilot setup markers to: ${outputPath}`)
  } finally {
    db.close()
  }
}
