/**
 * Create VS Code state.vscdb with GitHub OAuth token
 *
 * This helper creates a SQLite database in the format VS Code uses
 * for storing authentication state, allowing us to inject OAuth tokens
 * obtained via Device Flow.
 *
 * VS Code stores GitHub auth in state.vscdb under the key:
 * - github.auth.sessions (for GitHub authentication)
 *
 * The value is a JSON object mapping session IDs to session data.
 */

import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'

// GitHub OAuth scopes for Copilot
const COPILOT_SCOPES = ['read:user', 'user:email', 'copilot']

type GitHubSession = {
  id: string
  accessToken: string
  account: {
    label: string
    id: string
  }
  scopes: string[]
}

type SessionsStore = {
  [sessionId: string]: GitHubSession
}

/**
 * Create a VS Code state.vscdb file with GitHub OAuth session
 *
 * @param accessToken GitHub OAuth access token (gho_* format)
 * @param outputPath Path to write the state.vscdb file
 * @param accountInfo Optional account info (will be fetched from GitHub if not provided)
 */
export async function createVSCodeState(
  accessToken: string,
  outputPath: string,
  accountInfo?: { login: string; id: number }
): Promise<void> {
  // Fetch account info from GitHub if not provided
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
      // Use placeholder if fetch fails
      account = { login: 'github-user', id: 0 }
      console.log('[CreateState] Using placeholder account info')
    }
  }

  // Create session ID (VS Code uses UUID-like format)
  const sessionId = `github-session-${Date.now()}`

  // Create session data in VS Code's expected format
  const session: GitHubSession = {
    id: sessionId,
    accessToken,
    account: {
      label: account.login,
      id: String(account.id),
    },
    scopes: COPILOT_SCOPES,
  }

  const sessionsStore: SessionsStore = {
    [sessionId]: session,
  }

  // VS Code expects the sessions to be stored with a specific key format
  // The key is "github.auth.sessions" and value is JSON stringified sessions
  const stateKey = 'github.auth.sessions'
  const stateValue = JSON.stringify(sessionsStore)

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath)
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  // Create SQLite database
  const db = new Database(outputPath)

  try {
    // Create the ItemTable that VS Code uses
    db.exec(`
      CREATE TABLE IF NOT EXISTS ItemTable (
        key TEXT PRIMARY KEY,
        value BLOB
      )
    `)

    // Insert the GitHub auth session
    const insert = db.prepare(
      'INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)'
    )
    insert.run(stateKey, stateValue)

    // Also add a marker to indicate this is a valid VS Code state db
    insert.run('vscode.extensionGlobalState.version', '1')

    console.log(`[CreateState] Created state.vscdb at: ${outputPath}`)
    console.log(`[CreateState] GitHub session: ${sessionId}`)
    console.log(`[CreateState] Account: ${account.login} (${account.id})`)
    console.log(`[CreateState] Scopes: ${COPILOT_SCOPES.join(', ')}`)
  } finally {
    db.close()
  }
}

/**
 * Create state.vscdb from a previously stored token file
 */
export async function createStateFromTokenFile(
  tokenFilePath: string,
  outputPath: string
): Promise<void> {
  if (!fs.existsSync(tokenFilePath)) {
    throw new Error(`Token file not found: ${tokenFilePath}`)
  }

  const tokenData = JSON.parse(fs.readFileSync(tokenFilePath, 'utf8'))
  const { accessToken } = tokenData

  if (!accessToken) {
    throw new Error('No accessToken found in token file')
  }

  await createVSCodeState(accessToken, outputPath)
}

/**
 * Verify a state.vscdb file contains valid GitHub auth
 */
export function verifyStateFile(statePath: string): boolean {
  if (!fs.existsSync(statePath)) {
    console.log('[VerifyState] File does not exist')
    return false
  }

  try {
    const db = new Database(statePath, { readonly: true })
    const row = db
      .prepare('SELECT value FROM ItemTable WHERE key = ?')
      .get('github.auth.sessions')
    db.close()

    if (!row) {
      console.log('[VerifyState] No github.auth.sessions key found')
      return false
    }

    const sessions = JSON.parse((row as { value: string }).value)
    const sessionIds = Object.keys(sessions)

    if (sessionIds.length === 0) {
      console.log('[VerifyState] Sessions object is empty')
      return false
    }

    const firstSession = sessions[sessionIds[0]]
    console.log(`[VerifyState] Found session: ${firstSession.id}`)
    console.log(`[VerifyState] Account: ${firstSession.account?.label}`)
    console.log(
      `[VerifyState] Token starts with: ${firstSession.accessToken?.substring(0, 10)}...`
    )

    return Boolean(firstSession.accessToken)
  } catch (err) {
    console.log(`[VerifyState] Error: ${err}`)
    return false
  }
}
