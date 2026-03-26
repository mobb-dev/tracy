/**
 * Reusable UI interaction helpers for Cursor E2E tests.
 * Extracts common patterns from the Playwright test into composable functions.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import type { ElectronApplication, Page } from 'playwright'

/**
 * Dismiss common popup dialogs that may block test interaction:
 * - Git repository dialog
 * - Login/Sign-in prompts
 * - Agent layout tour
 * - Update notifications
 */
export async function dismissDialogs(mainWindow: Page): Promise<void> {
  // Git repository dialog ("Never" button)
  try {
    const neverButton = mainWindow.locator('button:has-text("Never")')
    if (await neverButton.isVisible({ timeout: 2000 })) {
      console.log('  Found Git dialog, clicking "Never"...')
      await neverButton.click()
      await mainWindow.waitForTimeout(500)
    }
  } catch {
    // No Git dialog found
  }

  // Login/sign-in buttons
  try {
    const loginDialogSelectors = [
      'button:has-text("Not now")',
      'button:has-text("Skip")',
      'button:has-text("Cancel")',
      'button:has-text("Close")',
      '[aria-label="Close"]',
    ]
    for (const selector of loginDialogSelectors) {
      const button = mainWindow.locator(selector).first()
      if (await button.isVisible({ timeout: 1000 })) {
        console.log(`  Found login/dialog dismiss button: ${selector}`)
        await button.click()
        await mainWindow.waitForTimeout(500)
        break
      }
    }
  } catch {
    // No login dialog found
  }

  // Escape any modals
  await mainWindow.keyboard.press('Escape')
  await mainWindow.waitForTimeout(500)

  // Agent Layout tour
  try {
    const revertLayoutButton = mainWindow.locator(
      'button:has-text("Revert to editor layout")'
    )
    if (await revertLayoutButton.isVisible({ timeout: 1000 })) {
      console.log('  Found Agent Layout tour, dismissing with Escape...')
      await mainWindow.keyboard.press('Escape')
      await mainWindow.waitForTimeout(500)
    }
  } catch {
    // No Agent Layout tour found
  }

  // Escape again for any remaining dialogs
  await mainWindow.keyboard.press('Escape')
  await mainWindow.waitForTimeout(500)

  // Update notifications
  try {
    const laterButton = mainWindow
      .locator('button:has-text("Later")')
      .first()
    if (await laterButton.isVisible({ timeout: 2000 })) {
      console.log('  Found update notification, clicking "Later"...')
      await laterButton.click()
      await mainWindow.waitForTimeout(500)
    }
  } catch {
    // No update notification found
  }
}

/**
 * Open the Agent/Composer panel and focus the chat input.
 * Returns true if the input was successfully focused.
 */
export async function openAgentPanel(mainWindow: Page): Promise<boolean> {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await mainWindow.keyboard.press(`${modifier}+L`)
  await mainWindow.waitForTimeout(1500)

  // Click on the chat input textarea
  const chatInputSelectors = [
    'textarea[placeholder*="Plan"]',
    'textarea[placeholder*="context"]',
    '[class*="composer"] textarea',
    '[class*="chat"] textarea',
    '[class*="aichat"] textarea',
    'div[contenteditable="true"]',
  ]

  for (const selector of chatInputSelectors) {
    try {
      const input = mainWindow.locator(selector).first()
      if (await input.isVisible({ timeout: 1000 })) {
        console.log(`  Found chat input with selector: ${selector}`)
        await input.click()
        await mainWindow.waitForTimeout(500)
        return true
      }
    } catch {
      // Try next selector
    }
  }

  // Fallback: click on placeholder text
  try {
    const placeholderArea = mainWindow
      .locator('text=Plan, @ for context')
      .first()
    if (await placeholderArea.isVisible({ timeout: 1000 })) {
      await placeholderArea.click()
      await mainWindow.waitForTimeout(500)
      return true
    }
  } catch {
    // Could not click placeholder area
  }

  return false
}

/**
 * Type a prompt into the Agent panel and submit it.
 */
export async function typeAndSubmitPrompt(
  mainWindow: Page,
  prompt: string
): Promise<void> {
  console.log(`  Typing prompt: "${prompt}"`)
  await mainWindow.keyboard.type(prompt, { delay: 50 })
  await mainWindow.waitForTimeout(1000)

  console.log('  Submitting prompt...')
  await mainWindow.keyboard.press('Enter')
  await mainWindow.waitForTimeout(2000)
}

/**
 * Check for authentication or subscription issues in the Cursor UI.
 * Throws if an auth issue is detected.
 */
export async function checkForAuthIssues(mainWindow: Page): Promise<void> {
  const authIssueSelectors = [
    'text=/sign in|log in|login/i',
    'text=/subscribe|subscription|upgrade/i',
    'text=/free trial|trial ended/i',
    'text=/limit reached|rate limit/i',
    'text=/authentication|authenticate/i',
  ]

  for (const selector of authIssueSelectors) {
    try {
      const element = mainWindow.locator(selector).first()
      if (await element.isVisible({ timeout: 1000 })) {
        const text = await element.textContent()
        console.log(`  Potential auth issue detected: "${text}"`)
        await mainWindow.screenshot({
          path: 'test-results/error-auth-issue-detected.png',
        })
        throw new Error(
          'Cursor authentication/subscription issue detected. ' +
            'The auth tokens may be expired. Run: npm run e2e:refresh-auth'
        )
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('authentication')) {
        throw err
      }
      // Selector not found, continue
    }
  }
}

/**
 * Wait for AI generation to complete and accept the changes.
 * Returns true if code generation was detected.
 */
export async function waitForCodeGenerationAndAccept(
  mainWindow: Page,
  timeout: number
): Promise<boolean> {
  let generationCompleted = false

  try {
    await mainWindow.waitForSelector(
      'text=/Keep All|Undo All|Accept|Reject/i',
      { timeout }
    )
    console.log('  Generation completion detected (found action buttons)')
    generationCompleted = true

    // Click Accept
    console.log('  Clicking Accept to apply AI changes...')
    const acceptButton = mainWindow
      .locator('button:has-text("Accept")')
      .first()
    if (await acceptButton.isVisible({ timeout: 3000 })) {
      await acceptButton.click()
      console.log('  Clicked Accept button')
      await mainWindow.waitForTimeout(2000)
    } else {
      // Try "Keep All"
      const keepAllButton = mainWindow
        .locator('button:has-text("Keep All")')
        .first()
      if (await keepAllButton.isVisible({ timeout: 2000 })) {
        await keepAllButton.click()
        console.log('  Clicked Keep All button')
        await mainWindow.waitForTimeout(2000)
      }
    }
  } catch {
    console.log('  Could not detect completion UI, waiting additional time...')
    await mainWindow.waitForTimeout(10000)
  }

  // Handle approval dialogs (AI agent wants to run commands)
  try {
    const skipButton = mainWindow.locator('button:has-text("Skip")').first()
    if (await skipButton.isVisible({ timeout: 3000 })) {
      console.log('  Found approval dialog, clicking Skip...')
      await skipButton.click()
      await mainWindow.waitForTimeout(2000)
    }
  } catch {
    // No approval dialog
  }

  // Verify code was generated
  const codeIndicators = [
    'pre code',
    '.monaco-editor',
    'text=/function|const|let|var|export/i',
  ]

  for (const selector of codeIndicators) {
    try {
      const element = mainWindow.locator(selector).first()
      if (await element.isVisible({ timeout: 2000 })) {
        console.log(`  Code indicator found: ${selector}`)
        return true
      }
    } catch {
      // Continue checking
    }
  }

  return generationCompleted
}

/**
 * Open the Output panel and select the Mobb AI Tracer channel.
 * Captures the output content to a file.
 */
export async function captureExtensionOutput(
  mainWindow: Page,
  electronApp: ElectronApplication
): Promise<void> {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

  // Dismiss active panels
  await mainWindow.keyboard.press('Escape')
  await mainWindow.waitForTimeout(300)
  await mainWindow.keyboard.press('Escape')
  await mainWindow.waitForTimeout(300)

  // Click in editor area
  try {
    const editorArea = mainWindow.locator('.editor-group-container').first()
    if (await editorArea.isVisible({ timeout: 1000 })) {
      await editorArea.click()
    }
  } catch {
    await mainWindow.mouse.click(600, 400)
  }
  await mainWindow.waitForTimeout(300)

  // Open Command Palette
  await mainWindow.keyboard.press(`${modifier}+Shift+KeyP`)
  await mainWindow.waitForTimeout(500)

  // Show output channels
  await mainWindow.keyboard.type('Output: Show Output Channels')
  await mainWindow.waitForTimeout(300)
  await mainWindow.keyboard.press('Enter')
  await mainWindow.waitForTimeout(1000)

  // Filter for Mobb AI Tracer
  await mainWindow.keyboard.type('mobb-ai-tracer')
  await mainWindow.waitForTimeout(500)
  await mainWindow.keyboard.press('Enter')
  await mainWindow.waitForTimeout(1000)

  // Copy content
  try {
    await mainWindow.keyboard.press(`${modifier}+KeyA`)
    await mainWindow.waitForTimeout(200)
    await mainWindow.keyboard.press(`${modifier}+KeyC`)
    await mainWindow.waitForTimeout(200)

    const clipboardContent = await electronApp.evaluate(
      async ({ clipboard }) => clipboard.readText()
    )

    if (clipboardContent && clipboardContent.length > 0) {
      fs.writeFileSync(
        path.join('test-results', 'extension-output.txt'),
        clipboardContent
      )
      console.log(
        `  Saved ${clipboardContent.length} chars to extension-output.txt`
      )
    }
  } catch (copyErr) {
    console.log(`  Could not copy output content: ${copyErr}`)
  }
}

/**
 * Capture extension host logs from Cursor's log directory.
 * Useful for debugging upload failures.
 */
export function captureExtensionLogs(testProfileDir: string): void {
  try {
    const logsDir = path.join(testProfileDir, 'logs')
    if (!fs.existsSync(logsDir)) {
      console.log(`  No logs directory found at ${logsDir}`)
      return
    }

    const logFiles = fs.readdirSync(logsDir, { recursive: true }) as string[]
    console.log(`  Found ${logFiles.length} log files in ${logsDir}`)

    for (const logFile of logFiles) {
      const logPath = path.join(logsDir, logFile)
      if (
        !fs.statSync(logPath).isFile() ||
        (!logFile.includes('exthost') && !logFile.includes('extension'))
      ) {
        continue
      }

      const content = fs.readFileSync(logPath, 'utf8')
      const destPath = path.join(
        'test-results',
        `log-${path.basename(logFile)}`
      )
      fs.writeFileSync(destPath, content)
      console.log(`  Copied ${logFile} (${content.length} chars)`)

      if (content.includes('MOBB-TRACER')) {
        console.log('  Found MOBB-TRACER entries in logs')
      }

      // Print key log contents for CI debugging
      const lines = content.split('\n')
      if (logFile.includes('mobb-ai-tracer')) {
        console.log(`\n  Contents of ${path.basename(logFile)}:`)
        console.log('  ' + '-'.repeat(58))
        console.log(lines.slice(0, 150).join('\n'))
        if (lines.length > 150) {
          console.log(`\n  ... (${lines.length - 150} more lines) ...`)
        }
        console.log('  ' + '-'.repeat(58))
      } else if (logFile.includes('exthost.log')) {
        console.log(`\n  Contents of ${path.basename(logFile)}:`)
        console.log('  ' + '-'.repeat(58))
        console.log(lines.slice(-50).join('\n'))
        console.log('  ' + '-'.repeat(58))
      }
    }
  } catch (e) {
    console.log(`  Could not capture extension host logs: ${e}`)
  }
}
