/**
 * Device Flow OAuth Automation
 *
 * Fully automated GitHub OAuth using the Device Flow.
 * This approach:
 * 1. Requests device code via API (no browser)
 * 2. Opens Playwright browser and logs into GitHub
 * 3. Enters device code at github.com/login/device
 * 4. Polls for OAuth token
 * 5. Returns token for injection into VS Code
 */

import { chromium, firefox } from '@playwright/test'

import {
  pollForAccessToken,
  requestDeviceCode,
} from './device-code-api'
import {
  getVerificationCodeFromImapMail,
  loadEmailCredentials,
} from './email-verification'
import type { OAuthCredentials } from './oauth-config'
import { loadCredentialsFromEnv, storeOAuthToken } from './oauth-config'

export type DeviceFlowResult = {
  success: boolean
  accessToken?: string
  error?: string
}

/**
 * Automate GitHub login and device code entry using Playwright
 */
async function automateDeviceCodeEntry(
  userCode: string,
  credentials: OAuthCredentials,
  options: { headless?: boolean; useFirefox?: boolean } = {}
): Promise<void> {
  console.log('[DeviceFlow] Starting browser automation...')
  console.log(`[DeviceFlow]   User code to enter: ${userCode}`)
  console.log(`[DeviceFlow]   Headless: ${options.headless}`)
  console.log(
    `[DeviceFlow]   Browser: ${options.useFirefox ? 'Firefox' : 'Chromium'}`
  )

  const browserType = options.useFirefox ? firefox : chromium

  console.log('[DeviceFlow] Launching browser...')
  const browser = await browserType
    .launch({
      headless: options.headless ?? false,
      args: options.useFirefox
        ? []
        : ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    })
    .catch((launchError) => {
      console.error(
        `[DeviceFlow] FAILED to launch browser: ${launchError instanceof Error ? launchError.message : launchError}`
      )
      throw launchError
    })
  console.log('[DeviceFlow] Browser launched successfully')

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
  })

  // Add stealth scripts for Chromium
  if (!options.useFirefox) {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      ;(window as any).chrome = { runtime: {} }
    })
  }

  const page = await context.newPage()

  try {
    // Step 1: Go to GitHub login
    console.log('[DeviceFlow] Navigating to GitHub login...')
    await page.goto('https://github.com/login', {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForTimeout(1000)

    // Check for Cloudflare
    const content = await page.content()
    if (content.includes('Just a moment') || content.includes('Cloudflare')) {
      throw new Error('Cloudflare challenge detected. Cannot automate.')
    }

    // Step 2: Enter credentials
    const loginField = page.locator('input[name="login"]')
    if (await loginField.isVisible({ timeout: 5000 })) {
      console.log('[DeviceFlow] Entering credentials...')
      await loginField.fill(credentials.email)
      await page.locator('input[name="password"]').fill(credentials.password)
      await page.locator('input[type="submit"]').click()

      // Wait for login to complete
      await page.waitForTimeout(3000)

      // Take screenshot to see what page we're on after login
      await page.screenshot({
        path: 'test-results/00-device-after-login.png',
        fullPage: true,
      })
      const currentUrl = page.url()
      console.log(`[DeviceFlow] After login - URL: ${currentUrl}`)

      // Check for GitHub Device Verification (NOT 2FA)
      // This is a separate security feature that requires email verification
      // on new/unrecognized devices. We handle it by fetching the code from email.
      if (currentUrl.includes('/sessions/verified-device')) {
        await page.screenshot({
          path: 'test-results/01-device-verification-detected.png',
          fullPage: true,
        })
        console.log('[DeviceFlow] GitHub Device Verification detected')
        console.log('[DeviceFlow] Fetching verification code from email...')

        // Get email credentials
        const emailCreds = loadEmailCredentials()
        if (!emailCreds) {
          throw new Error(
            'GitHub Device Verification requires email access. ' +
              'Set MOBB_CI_TEST_EMAIL_USERNAME and MOBB_CI_TEST_EMAIL_PASSWORD.'
          )
        }

        // Fetch verification code from email
        const codes = await getVerificationCodeFromImapMail({
          email: emailCreds.email,
          password: emailCreds.password,
          fromEmailEndsWith: 'noreply@github.com',
          toEmail: credentials.email,
          subjectContent: '[GitHub] Please verify your device',
          verificationCodeRegex: /Verification code: ([0-9]{6})/,
          timeoutMs: 15000, // Wait 15s for email to arrive
        })

        if (codes.length === 0) {
          throw new Error(
            'No verification code found in email. ' +
              'Check MOBB_CI_TEST_EMAIL credentials and ensure email is accessible.'
          )
        }

        const verificationCode = codes[0]
        console.log(`[DeviceFlow] Got verification code: ${verificationCode}`)

        // Enter the verification code
        const codeInput = page.locator('input[name="otp"], input#otp')
        if (await codeInput.isVisible({ timeout: 5000 })) {
          await codeInput.fill(verificationCode)
          console.log('[DeviceFlow] Entered verification code')

          // Wait briefly for potential auto-submission
          await page.waitForTimeout(2000)

          // Check if form auto-submitted (page navigated away from verification)
          const currentUrl = page.url()
          if (currentUrl.includes('verified-device')) {
            // Still on verification page, need to click submit
            console.log(
              '[DeviceFlow] Form did not auto-submit, clicking submit'
            )
            const submitBtn = page
              .locator('button[type="submit"], input[type="submit"]')
              .first()
            await submitBtn.click()
            await page.waitForTimeout(3000)
          } else {
            console.log(
              `[DeviceFlow] Form auto-submitted, navigated to: ${currentUrl}`
            )
          }

          console.log('[DeviceFlow] Submitted device verification')
          await page.screenshot({
            path: 'test-results/02-device-verification-submitted.png',
            fullPage: true,
          })
        } else {
          throw new Error('Could not find verification code input field')
        }
      }

      // Check for actual 2FA (TOTP/authenticator app)
      const twoFactorField = page.locator('input[name="otp"], input#app_totp')
      if (
        await twoFactorField.isVisible({ timeout: 2000 }).catch(() => false)
      ) {
        await page.screenshot({
          path: 'test-results/03-device-2fa-detected.png',
          fullPage: true,
        })
        console.log('[DeviceFlow] Screenshot saved: device-2fa-detected.png')
        console.log(`[DeviceFlow] Page URL: ${currentUrl}`)
        console.log(
          `[DeviceFlow] Page title: ${await page.title().catch(() => 'unknown')}`
        )

        throw new Error(
          '2FA (TOTP/authenticator) required. The test account must not have 2FA enabled.'
        )
      }

      // Check for error
      const errorMsg = page.locator('.flash-error, .js-flash-alert')
      if (await errorMsg.isVisible({ timeout: 1000 }).catch(() => false)) {
        const errorText = await errorMsg.textContent()
        throw new Error(`Login failed: ${errorText}`)
      }
    }

    // Step 3: Navigate to device code page
    console.log('[DeviceFlow] Navigating to device code page...')
    await page.goto('https://github.com/login/device', {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForTimeout(1000)

    // Step 4: Handle the device activation flow
    // GitHub has a multi-step flow when already logged in:
    // 1. /login/device -> shows "Continue" button (select account)
    // 2. /login/device/select_account -> shows account with "Continue"
    // 3. /login/device -> shows code input

    // Keep navigating until we see the code input page
    for (let attempt = 0; attempt < 5; attempt++) {
      console.log(`[DeviceFlow] Step ${attempt + 1}: URL = ${page.url()}`)
      await page.screenshot({
        path: `test-results/0${attempt + 4}-device-step-${attempt}.png`,
      })

      // Check for error page
      if (page.url().includes('failure')) {
        throw new Error(`GitHub device flow failed: ${page.url()}`)
      }

      // Check if this is the code entry page (has 8 character input boxes)
      // Look for: "Authorize your device" OR multiple text inputs for the code
      const pageText = await page.textContent('body')
      const hasCodeInputs =
        (await page.locator('input[type="text"]').count()) >= 4
      const isCodeEntryPage =
        pageText?.includes('Authorize your device') ||
        pageText?.includes('Enter the code') ||
        (hasCodeInputs && !pageText?.includes('Use a different account'))

      if (isCodeEntryPage && hasCodeInputs) {
        console.log('[DeviceFlow] Found code entry page with input boxes!')
        break
      }

      // On account selection page - click Continue button
      // Debug: Log all buttons on the page
      const allButtons = await page.locator('button').all()
      console.log(`[DeviceFlow] Found ${allButtons.length} buttons on page`)
      for (let i = 0; i < Math.min(allButtons.length, 5); i++) {
        const button = allButtons[i]
        if (!button) continue // Skip if button doesn't exist

        const text = await button.textContent().catch(() => 'N/A')
        const visible = await button.isVisible().catch(() => false)
        console.log(
          `[DeviceFlow]   Button ${i}: "${text?.trim()}" visible=${visible}`
        )
      }

      // Try using getByRole for better button detection
      let clicked = false

      // Method 1: getByRole
      const continueByRole = page.getByRole('button', { name: /continue/i })
      if (
        await continueByRole.isVisible({ timeout: 1000 }).catch(() => false)
      ) {
        console.log('[DeviceFlow] Clicking Continue via getByRole...')
        await continueByRole.click()
        clicked = true
      }

      // Method 2: getByText
      if (!clicked) {
        const continueByText = page.getByText('Continue', { exact: true })
        if (
          await continueByText.isVisible({ timeout: 1000 }).catch(() => false)
        ) {
          console.log('[DeviceFlow] Clicking Continue via getByText...')
          await continueByText.click()
          clicked = true
        }
      }

      // Method 3: CSS selector
      if (!clicked) {
        const continueByCSS = page
          .locator('button')
          .filter({ hasText: 'Continue' })
          .first()
        if (
          await continueByCSS.isVisible({ timeout: 1000 }).catch(() => false)
        ) {
          console.log('[DeviceFlow] Clicking Continue via CSS filter...')
          await continueByCSS.click()
          clicked = true
        }
      }

      if (clicked) {
        await page.waitForLoadState('domcontentloaded')
        await page.waitForTimeout(2000)
      } else {
        console.log('[DeviceFlow] No Continue button found, waiting...')
        await page.waitForTimeout(2000)
      }
    }

    // Step 5: Enter user code
    // GitHub uses 8 individual input boxes for the code (XXXX-XXXX)
    // We need to type the code - the first input is focused, just type all chars
    console.log(`[DeviceFlow] Entering user code: ${userCode}`)

    // Remove any dashes from the code
    const cleanCode = userCode.replace(/-/g, '')
    console.log(`[DeviceFlow] Clean code (no dashes): ${cleanCode}`)

    // Find the first input in the code entry area and type the full code
    // GitHub's JS will auto-advance to next input
    const firstInput = page.locator('input[type="text"]').first()
    if (await firstInput.isVisible({ timeout: 5000 })) {
      await firstInput.click()
      // Type each character slowly - GitHub JS handles advancing
      await page.keyboard.type(cleanCode, { delay: 100 })
      console.log('[DeviceFlow] Code entered!')
      await page.screenshot({ path: 'test-results/09-device-code-entered.png' })
    } else {
      await page.screenshot({
        path: 'test-results/09-device-code-page-error.png',
      })
      console.log('[DeviceFlow] Page URL:', page.url())
      throw new Error('Could not find code input. Check screenshot.')
    }

    // Find and click continue/submit button
    const submitButton = page.locator(
      'button[type="submit"], button:has-text("Continue"), input[type="submit"]'
    )
    await submitButton.click()
    console.log('[DeviceFlow] Clicked Continue after code entry')
    await page.waitForTimeout(3000)

    // Step 6: Authorize the application
    // The authorization page may require scrolling to see the button
    console.log('[DeviceFlow] Looking for authorization page...')
    console.log(`[DeviceFlow] Current URL: ${page.url()}`)
    await page.screenshot({
      path: 'test-results/10-device-authorize-page.png',
      fullPage: true,
    })

    // Scroll down to ensure authorize button is visible
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.waitForTimeout(1000)

    // Debug: List ALL buttons and inputs on the page
    const allButtons = await page.locator('button, input[type="submit"]').all()
    console.log(
      `[DeviceFlow] Found ${allButtons.length} buttons/inputs on authorization page:`
    )
    for (let i = 0; i < allButtons.length; i++) {
      const btn = allButtons[i]
      const text = await btn.textContent().catch(() => 'N/A')
      const name = await btn.getAttribute('name').catch(() => null)
      const value = await btn.getAttribute('value').catch(() => null)
      const className = await btn.getAttribute('class').catch(() => null)
      const visible = await btn.isVisible().catch(() => false)
      console.log(
        `[DeviceFlow]   ${i}: text="${text?.trim()}" name="${name}" value="${value}" class="${className}" visible=${visible}`
      )
    }

    // GitHub authorization page has:
    // - A gray "Cancel" button (denies access)
    // - A green "Authorize [app-name]" button (grants access)
    // We need to find the GREEN button (btn-primary) that says "Authorize"
    // IMPORTANT: The first button[name="authorize"] might be Cancel!
    let authorizeClicked = false

    // Try to find the green Authorize button specifically (should have btn-primary class)
    const greenAuthorizeBtn = page
      .locator(
        'button.btn-primary:has-text("Authorize"), button.color-bg-success-emphasis:has-text("Authorize")'
      )
      .first()
    if (
      await greenAuthorizeBtn.isVisible({ timeout: 2000 }).catch(() => false)
    ) {
      console.log('[DeviceFlow] Found GREEN Authorize button!')
      await greenAuthorizeBtn.scrollIntoViewIfNeeded()
      await greenAuthorizeBtn.click()
      authorizeClicked = true
      console.log('[DeviceFlow] Clicked GREEN Authorize button!')
    }

    // Fallback: Try getByRole with exact name match
    if (!authorizeClicked) {
      // The authorize button should say "Authorize visual-studio-code" or similar
      const authorizeByRole = page.getByRole('button', {
        name: /authorize.*visual.*studio|authorize.*vscode/i,
      })
      if (
        await authorizeByRole.isVisible({ timeout: 2000 }).catch(() => false)
      ) {
        console.log('[DeviceFlow] Found Authorize button via getByRole!')
        await authorizeByRole.scrollIntoViewIfNeeded()
        await authorizeByRole.click()
        authorizeClicked = true
        console.log('[DeviceFlow] Clicked Authorize button via getByRole!')
      }
    }

    // Another fallback: Look for a button with name="authorize" that ISN'T Cancel
    if (!authorizeClicked) {
      const authorizeButtons = await page
        .locator('button[name="authorize"]')
        .all()
      for (const btn of authorizeButtons) {
        const text = await btn.textContent().catch(() => '')
        const className = await btn.getAttribute('class').catch(() => '')
        // Skip if it's the Cancel button (gray, not primary)
        if (
          text?.toLowerCase().includes('cancel') ||
          (!className?.includes('primary') && !className?.includes('success'))
        ) {
          console.log(
            `[DeviceFlow] Skipping cancel/gray button: "${text?.trim()}"`
          )
          continue
        }
        console.log(
          `[DeviceFlow] Found authorize button: "${text?.trim()}" class="${className}"`
        )
        await btn.scrollIntoViewIfNeeded()
        await btn.click()
        authorizeClicked = true
        console.log('[DeviceFlow] Clicked authorize button!')
        break
      }
    }

    // Last resort: Find any button with "Authorize" text (but not Cancel)
    if (!authorizeClicked) {
      const allAuthBtns = await page
        .locator('button:has-text("Authorize")')
        .all()
      for (const btn of allAuthBtns) {
        const text = await btn.textContent().catch(() => '')
        if (text?.toLowerCase().includes('cancel')) {
          continue
        }
        console.log(
          `[DeviceFlow] Clicking fallback authorize button: "${text?.trim()}"`
        )
        await btn.scrollIntoViewIfNeeded()
        await btn.click()
        authorizeClicked = true
        break
      }
    }

    if (!authorizeClicked) {
      // Debug: list all buttons
      const allBtns = await page.locator('button').all()
      console.log(
        `[DeviceFlow] No authorize button found. ${allBtns.length} buttons on page:`
      )
      for (let i = 0; i < Math.min(allBtns.length, 10); i++) {
        const text = await allBtns[i].textContent().catch(() => 'N/A')
        const visible = await allBtns[i].isVisible().catch(() => false)
        console.log(
          `[DeviceFlow]   Button ${i}: "${text?.trim()}" visible=${visible}`
        )
      }
      await page.screenshot({
        path: 'test-results/11-device-no-authorize-btn-error.png',
        fullPage: true,
      })
    }

    // After clicking Authorize, GitHub may close/redirect the page
    // This is expected behavior - wrap in try-catch
    try {
      await page.waitForTimeout(3000)

      // Check for success
      const pageContent = await page.content()
      const currentUrl = page.url()
      console.log(`[DeviceFlow] Final URL: ${currentUrl}`)

      if (
        pageContent.includes('Congratulations') ||
        pageContent.includes('successfully') ||
        pageContent.includes('connected') ||
        pageContent.includes('device is now connected')
      ) {
        console.log('[DeviceFlow] Authorization successful!')
        await page.screenshot({ path: 'test-results/12-device-success.png' })
      } else {
        await page.screenshot({
          path: 'test-results/13-device-code-result.png',
          fullPage: true,
        })
        console.log(
          '[DeviceFlow] Authorization may have succeeded. Check screenshots.'
        )
      }
    } catch (err) {
      // Page closed after authorize - this is OK, the token polling will complete
      console.log(
        '[DeviceFlow] Page closed after authorization (expected behavior)'
      )
      if (authorizeClicked) {
        console.log(
          '[DeviceFlow] Authorize was clicked - token polling should succeed'
        )
      }
    }
  } finally {
    await browser.close()
  }
}

/**
 * Complete Device Flow OAuth with full automation
 *
 * @param credentials GitHub credentials for the test account
 * @param options Optional configuration
 * @returns The OAuth access token
 */
export async function performDeviceFlowOAuth(
  credentials: OAuthCredentials,
  options: {
    headless?: boolean
    useFirefox?: boolean
    timeout?: number
  } = {}
): Promise<DeviceFlowResult> {
  // Track if we should abort polling
  let abortPolling = false

  try {
    // Step 1: Get device code
    const deviceCode = await requestDeviceCode()

    // Step 2: Start polling in background with abort capability
    // IMPORTANT: We wrap the polling promise to prevent unhandled rejections
    // if the browser automation fails before polling completes
    const tokenPromise = pollForAccessToken(
      deviceCode.device_code,
      deviceCode.interval,
      options.timeout || deviceCode.expires_in
    ).catch((err) => {
      // Catch polling errors - if we've already aborted, suppress the error
      if (abortPolling) {
        console.log('[DeviceFlow] Polling aborted (browser automation failed)')
        return null // Return null to indicate polling was aborted
      }
      // Re-throw if this is a real polling error
      throw err
    })

    // Step 3: Automate browser to enter code
    try {
      await automateDeviceCodeEntry(deviceCode.user_code, credentials, {
        headless: options.headless,
        useFirefox: options.useFirefox,
      })
    } catch (browserError) {
      // Browser automation failed - abort polling to prevent dangling promise
      abortPolling = true
      console.log(
        `[DeviceFlow] Browser automation failed: ${browserError instanceof Error ? browserError.message : browserError}`
      )
      throw browserError
    }

    // Step 4: Wait for token
    console.log('[DeviceFlow] Waiting for token from polling...')
    const accessToken = await tokenPromise

    // Check if polling was aborted (shouldn't happen here, but be safe)
    if (accessToken === null) {
      throw new Error('Polling was aborted')
    }

    return {
      success: true,
      accessToken,
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

// Re-export for backwards compatibility
export { loadCredentialsFromEnv, storeOAuthToken } from './oauth-config'
export { pollForAccessToken, requestDeviceCode } from './device-code-api'
export { automateDeviceCodeEntry }
