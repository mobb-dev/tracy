// Test-only helper extension. Requests a GitHub authentication session so the
// E2E harness can drive VS Code's NATIVE sign-in flow (loopback OAuth) and let
// VS Code persist the session with its own platform encryption. This is the
// only reliable way to authenticate Copilot on Windows VS Code >=1.123, where
// the secret store uses a machine-bound key that an injected state.vscdb cannot
// satisfy. Not shipped to users — lives under __tests__ and is side-loaded only
// into the disposable E2E profile.
const vscode = require('vscode')

// Must match the scopes VS Code/Copilot request (see device-code-api.ts).
const SCOPES = ['read:user', 'user:email', 'repo', 'workflow']

async function requestSession() {
  try {
    console.log('[AuthTrigger] requesting GitHub session (createIfNone)...')
    const session = await vscode.authentication.getSession('github', SCOPES, {
      createIfNone: true,
    })
    console.log(
      `[AuthTrigger] session acquired for: ${session ? session.account.label : 'none'}`
    )
    return session
  } catch (err) {
    console.log(`[AuthTrigger] getSession failed: ${err && err.message}`)
    return undefined
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('mobbE2eAuthTrigger.signIn', requestSession)
  )
  // Delay slightly so the harness can install its openExternal interceptor in
  // the Electron main process before the loopback URL is opened.
  setTimeout(requestSession, 8000)
}

module.exports = { activate }
