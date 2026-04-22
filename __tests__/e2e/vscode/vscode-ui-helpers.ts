/**
 * Reusable UI interaction helpers for VS Code + Copilot Chat E2E tests.
 *
 * Shared between Linux and Windows native-runner Playwright tests.
 * VS Code Copilot Chat differs from Cursor's agent panel — the input is a
 * Monaco editor (contenteditable), not a plain textarea, so the focus
 * strategy targets `.native-edit-context[role="textbox"]` (see
 * COPILOT_INPUT_FOCUS_RESEARCH.md for the full strategy matrix).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import type { ElectronApplication, Page } from 'playwright'

/**
 * Click "Continue with GitHub" on any sign-in modal that's currently visible.
 * Covers both the Welcome-to-VS-Code modal (appears at launch) and the
 * Sign-in-to-use-AI-Features modal (appears AFTER prompt submission).
 * Safe to call repeatedly. Returns true when a click fired.
 *
 * Tries several locator strategies because VS Code renders these modals
 * differently on different platforms (top-level DOM, iframe, shadow root).
 */
export async function dismissAIFeaturesModal(
  mainWindow: Page,
  timeoutMs = 1500
): Promise<boolean> {
  // GATE on the modal's title text — "Sign in to use AI Features" / "Welcome
  // to VS Code". Without this gate, the click fires on any stray "Continue
  // with GitHub" button (e.g. the Accounts sidebar that pops up during
  // Copilot's own auth handshake) and interrupts generation mid-flight —
  // exactly the regression seen on run 24573150937's Linux VS Code log.
  const titlePatterns = [
    /Sign in to use AI Features/i,
    /Welcome to VS Code/i,
    /Sign in to continue with AI-powered development/i,
  ]
  let modalTitleVisible = false
  for (const pat of titlePatterns) {
    try {
      const loc = mainWindow.getByText(pat).first()
      if (await loc.isVisible({ timeout: Math.min(timeoutMs, 500) })) {
        modalTitleVisible = true
        break
      }
    } catch {
      // try next pattern
    }
  }
  if (!modalTitleVisible) return false

  // PREFERRED: click the modal's X (close) button. Closing without signing
  // in lets Copilot fall back to the GitHub session already loaded from
  // our seeded state.vscdb, which is exactly what we want. Clicking
  // "Continue with GitHub" kicks off a fresh OAuth handshake that often
  // hangs in CI (no browser) or swaps out our pre-seeded session for a
  // partial one.
  const closeLocators = [
    () => mainWindow.locator('.codicon-close').first(),
    () => mainWindow.getByRole('button', { name: /^Close$/i }).first(),
    () => mainWindow.locator('[aria-label="Close"]').first(),
    () => mainWindow.locator('button:has-text("×")').first(),
  ]
  for (const getLoc of closeLocators) {
    try {
      const loc = getLoc()
      if (await loc.isVisible({ timeout: 1000 })) {
        console.log('  Closing AI-features / welcome modal via X button...')
        await loc.click({ timeout: 5000 })
        await mainWindow.waitForTimeout(2000)
        return true
      }
    } catch {
      // try next
    }
  }

  // Fallback: keyboard Escape
  try {
    await mainWindow.keyboard.press('Escape')
    await mainWindow.waitForTimeout(1000)
    // Re-check: is the modal gone?
    for (const pat of titlePatterns) {
      const still = await mainWindow.getByText(pat).first().isVisible({ timeout: 500 }).catch(() => false)
      if (still) return false
    }
    console.log('  Dismissed modal via Escape')
    return true
  } catch {
    // continue
  }

  // LAST RESORT: click Continue with GitHub (risks triggering OAuth flow)
  const buttonLocators = [
    () => mainWindow.locator('button:has-text("Continue with GitHub")').first(),
    () => mainWindow.getByRole('button', { name: /Continue with GitHub/i }).first(),
    () => mainWindow.locator('[role="button"]:has-text("Continue with GitHub")').first(),
  ]
  for (const getLoc of buttonLocators) {
    try {
      const loc = getLoc()
      if (await loc.isVisible({ timeout: 1000 })) {
        console.log(
          '  Clicking "Continue with GitHub" on AI-features / welcome modal (last resort)...'
        )
        await loc.click({ timeout: 5000 })
        await mainWindow.waitForTimeout(3500)
        return true
      }
    } catch {
      // try next
    }
  }

  // Iframe fallback (rare, kept for safety)
  try {
    for (const f of mainWindow.frames()) {
      if (f === mainWindow.mainFrame()) continue
      const btn = f.locator('button:has-text("Continue with GitHub")').first()
      if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
        console.log(
          `  Clicking "Continue with GitHub" in iframe (${f.url().slice(0, 80)})`
        )
        await btn.click({ timeout: 5000 })
        await mainWindow.waitForTimeout(3500)
        return true
      }
    }
  } catch {
    // nothing
  }

  console.log(
    '  Modal title visible but no Continue-with-GitHub button found'
  )
  return false
}

/** Dismiss common blocking dialogs (Git trust, updates, tours, AI-features sign-in). */
export async function dismissDialogs(mainWindow: Page): Promise<void> {
  await dismissAIFeaturesModal(mainWindow)

  // Git repository dialog / Workspace trust banner
  const neverSelectors = [
    'button:has-text("Never")',
    'button:has-text("Yes, I trust the authors")',
  ]
  for (const sel of neverSelectors) {
    try {
      const btn = mainWindow.locator(sel).first()
      if (await btn.isVisible({ timeout: 1500 })) {
        await btn.click()
        await mainWindow.waitForTimeout(500)
      }
    } catch {
      // no dialog
    }
  }

  // Generic dismiss buttons
  const dismissSelectors = [
    'button:has-text("Not now")',
    'button:has-text("Later")',
    'button:has-text("Skip")',
    'button:has-text("Cancel")',
    'button:has-text("Close")',
    '[aria-label="Close"]',
  ]
  for (const selector of dismissSelectors) {
    try {
      const button = mainWindow.locator(selector).first()
      if (await button.isVisible({ timeout: 800 })) {
        await button.click()
        await mainWindow.waitForTimeout(300)
      }
    } catch {
      // continue
    }
  }

  await mainWindow.keyboard.press('Escape')
  await mainWindow.waitForTimeout(300)
}

/**
 * Open the Copilot Chat panel using the VS Code command (survives UI reshuffles
 * better than a raw keyboard shortcut). Falls back to Ctrl/Cmd+Shift+I if the
 * command palette route fails.
 */
export async function openCopilotChat(mainWindow: Page): Promise<void> {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

  // Attempt 1: Command palette → "Chat: Focus on Chat View" (canonical)
  try {
    await mainWindow.keyboard.press(`${modifier}+Shift+KeyP`)
    await mainWindow.waitForTimeout(500)
    await mainWindow.keyboard.type('Chat: Focus on Chat View', { delay: 20 })
    await mainWindow.waitForTimeout(300)
    await mainWindow.keyboard.press('Enter')
    await mainWindow.waitForTimeout(1500)
  } catch {
    // fall through to shortcut
  }

  // Attempt 2: Keyboard shortcut (Ctrl/Cmd+Shift+I)
  await mainWindow.keyboard.press(`${modifier}+Shift+KeyI`)
  await mainWindow.waitForTimeout(1500)
}

/**
 * Focus the Copilot Chat input. The input is a Monaco `.native-edit-context`
 * contenteditable, so a direct DOM focus is the most reliable path.
 * Returns true if focus appears successful (verified via document.activeElement).
 */
export async function focusCopilotInput(mainWindow: Page): Promise<boolean> {
  // Strategy 1: Direct DOM focus (fastest, no event-system dependencies)
  try {
    const focused = await mainWindow.evaluate(() => {
      const el = document.querySelector('.native-edit-context[role="textbox"]')
      if (el) {
        ;(el as HTMLElement).focus()
        return true
      }
      return false
    })
    if (focused) {
      const activeClass = await mainWindow.evaluate(
        () => document.activeElement?.className || ''
      )
      if (activeClass.includes('native-edit-context')) {
        console.log('  Focused chat input via direct focus()')
        return true
      }
    }
  } catch (err) {
    console.log(`  Direct focus failed: ${err}`)
  }

  // Strategy 2: Click the native-edit-context
  const clickSelectors = [
    '.native-edit-context[role="textbox"]',
    '.interactive-input-editor .monaco-editor',
    '.chat-input-container .monaco-editor',
    '.chat-input-container',
  ]
  for (const sel of clickSelectors) {
    try {
      const loc = mainWindow.locator(sel).first()
      if (await loc.isVisible({ timeout: 1500 })) {
        await loc.click()
        await mainWindow.waitForTimeout(400)
        console.log(`  Focused chat input via click on: ${sel}`)
        return true
      }
    } catch {
      // try next
    }
  }

  // Strategy 3: getByRole textbox
  try {
    const tb = mainWindow.getByRole('textbox').first()
    if (await tb.isVisible({ timeout: 1500 })) {
      await tb.click()
      await mainWindow.waitForTimeout(400)
      console.log('  Focused chat input via getByRole(textbox)')
      return true
    }
  } catch {
    // give up
  }

  console.log('  Could not focus Copilot chat input')
  return false
}

/** Type a prompt and submit with Enter. */
export async function typeAndSubmitPrompt(
  mainWindow: Page,
  prompt: string
): Promise<void> {
  console.log(`  Typing prompt: "${prompt.slice(0, 60)}..."`)
  await mainWindow.keyboard.type(prompt, { delay: 30 })
  await mainWindow.waitForTimeout(800)
  await mainWindow.keyboard.press('Enter')
  await mainWindow.waitForTimeout(1500)
}

/**
 * Wait for Copilot generation to finish and accept/keep the produced edits.
 *
 * Detection strategy:
 *  - Wait for any "Keep"/"Accept"/"Continue" button, or the stop button
 *    to disappear (text "Stop" changes to "Send").
 *
 * Returns true if generation completion was detected.
 */
export async function waitForCopilotGenerationAndAccept(
  mainWindow: Page,
  timeout: number
): Promise<boolean> {
  console.log(`  Waiting for Copilot generation (timeout: ${timeout}ms)...`)

  // Poll for the AI-features modal in the background — it can appear at
  // any point after the prompt is submitted. Log every iteration so we
  // can see whether the poller is running even when it doesn't click.
  const deadline = Date.now() + timeout
  let iteration = 0
  const modalPoller = (async () => {
    while (Date.now() < deadline) {
      iteration++
      const clicked = await dismissAIFeaturesModal(mainWindow, 500)
      if (clicked) {
        console.log(
          `  AI-features modal dismissed during generation wait (poll #${iteration})`
        )
      } else if (iteration === 1 || iteration % 5 === 0) {
        console.log(`  Modal poller: no modal at iteration ${iteration}`)
      }
      await mainWindow.waitForTimeout(2000)
    }
  })()

  const completionRegex =
    /Keep All|Keep|Accept All|Accept|Continue|Undo|Apply/i

  let detected = false
  try {
    await mainWindow.waitForSelector(`button:text-matches("${completionRegex.source}", "i")`, {
      timeout,
    })
    detected = true
    console.log('  Generation completion button detected')
  } catch {
    console.log('  No completion button detected within timeout')
  }
  // Let the background poller finish
  await modalPoller.catch(() => {})

  // Click any tool approval buttons that appear before the final Keep
  // (Copilot can ask to approve terminal commands, file edits, etc.)
  const approvalButtonNames = ['Continue', 'Allow', 'Allow in this session']
  for (const name of approvalButtonNames) {
    try {
      const btn = mainWindow.locator(`button:has-text("${name}")`).first()
      if (await btn.isVisible({ timeout: 1500 })) {
        await btn.click()
        console.log(`  Clicked approval button: ${name}`)
        await mainWindow.waitForTimeout(1000)
      }
    } catch {
      // no such button
    }
  }

  // Click Keep/Accept in priority order
  const acceptButtonNames = ['Keep', 'Keep All', 'Accept', 'Accept All']
  for (const name of acceptButtonNames) {
    try {
      const btn = mainWindow.locator(`button:has-text("${name}")`).first()
      if (await btn.isVisible({ timeout: 1500 })) {
        await btn.click()
        console.log(`  Clicked ${name}`)
        await mainWindow.waitForTimeout(1500)
        break
      }
    } catch {
      // try next
    }
  }

  return detected
}

/**
 * Open the Output panel and dump the Mobb AI Tracer channel contents to
 * test-results/extension-output.txt. Best-effort — never throws.
 */
export async function captureExtensionOutput(
  mainWindow: Page,
  electronApp: ElectronApplication
): Promise<void> {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

  try {
    await mainWindow.keyboard.press('Escape')
    await mainWindow.waitForTimeout(200)
    await mainWindow.keyboard.press(`${modifier}+Shift+KeyP`)
    await mainWindow.waitForTimeout(500)
    await mainWindow.keyboard.type('Output: Show Output Channels', { delay: 20 })
    await mainWindow.waitForTimeout(300)
    await mainWindow.keyboard.press('Enter')
    await mainWindow.waitForTimeout(800)
    await mainWindow.keyboard.type('mobb-ai-tracer', { delay: 20 })
    await mainWindow.waitForTimeout(400)
    await mainWindow.keyboard.press('Enter')
    await mainWindow.waitForTimeout(1000)

    await mainWindow.keyboard.press(`${modifier}+KeyA`)
    await mainWindow.waitForTimeout(200)
    await mainWindow.keyboard.press(`${modifier}+KeyC`)
    await mainWindow.waitForTimeout(200)

    const clipboardContent = await electronApp.evaluate(
      async ({ clipboard }) => clipboard.readText()
    )
    if (clipboardContent && clipboardContent.length > 0) {
      const outPath = path.join('test-results', 'extension-output.txt')
      fs.writeFileSync(outPath, clipboardContent)
      console.log(`  Saved ${clipboardContent.length} chars to ${outPath}`)
    }
  } catch (err) {
    console.log(`  captureExtensionOutput failed: ${err}`)
  }
}

/**
 * Scan the test profile's Copilot / extension host logs for the
 * "GitHub token is invalid" / 401 signature. Used as a fallback on platforms
 * where the extension-host console event isn't piped to the page (Windows).
 *
 * Returns true if the logs contain evidence that the Copilot GitHub token
 * stored in VSCODE_STATE_VSCDB_B64 is expired.
 */
export function copilotAuthErrorInLogs(testProfileDir: string): boolean {
  const logsDir = path.join(testProfileDir, 'logs')
  if (!fs.existsSync(logsDir)) return false

  const patterns = [
    /Your GitHub token is invalid/i,
    /sign out from your GitHub account/i,
    /401 (?:Unauthorized|status|\()/,
    /status of 401/i,
    /Bad credentials/i,
  ]

  const entries = fs.readdirSync(logsDir, { recursive: true }) as string[]
  for (const entry of entries) {
    const full = path.join(logsDir, entry)
    try {
      if (!fs.statSync(full).isFile()) continue
    } catch {
      continue
    }
    if (!/copilot|exthost|extension/i.test(entry)) continue
    try {
      const content = fs.readFileSync(full, 'utf8')
      for (const pat of patterns) {
        if (pat.test(content)) {
          console.log(
            `  Auth error signature matched in ${entry}: ${pat.source}`
          )
          return true
        }
      }
    } catch {
      // ignore unreadable file
    }
  }
  return false
}

/** Copy extension host logs from the test profile to test-results/. */
export function captureExtensionLogs(testProfileDir: string): void {
  try {
    const logsDir = path.join(testProfileDir, 'logs')
    if (!fs.existsSync(logsDir)) {
      console.log(`  No logs directory at ${logsDir}`)
      return
    }

    const entries = fs.readdirSync(logsDir, { recursive: true }) as string[]
    for (const entry of entries) {
      const full = path.join(logsDir, entry)
      if (!fs.statSync(full).isFile()) continue
      if (!entry.includes('exthost') && !entry.includes('extension')) continue

      const content = fs.readFileSync(full, 'utf8')
      const dest = path.join('test-results', `log-${path.basename(entry)}`)
      fs.writeFileSync(dest, content)
      console.log(`  Copied ${entry} (${content.length} chars)`)
    }
  } catch (err) {
    console.log(`  captureExtensionLogs failed: ${err}`)
  }
}
