/**
 * Cursor Login Helper for E2E Tests
 *
 * This module automates the Cursor login flow using Playwright.
 * It handles OAuth authentication via authenticator.cursor.sh and
 * injects the resulting tokens into Cursor's state.vscdb database.
 *
 * Flow:
 * 1. Launch a separate Playwright browser
 * 2. Navigate to Cursor's auth URL
 * 3. Enter credentials (email/password or OAuth)
 * 4. Capture the session token
 * 5. Inject token into Cursor's SQLite database
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import Database from 'better-sqlite3'
import type { Browser, BrowserContext } from 'playwright'
import { chromium } from 'playwright'

// Auth URL for Cursor
const CURSOR_AUTH_URL = 'https://authenticator.cursor.sh'

// Timeout for login operations
const LOGIN_TIMEOUT = 60000 // 60 seconds

export type CursorCredentials = {
  email: string
  password: string
}

export type LoginResult = {
  success: boolean
  error?: string
  token?: string
  email?: string
}

/**
 * Performs Cursor login via browser automation and returns auth tokens.
 *
 * @param credentials - Email and password for Cursor account
 * @param options - Additional options like headless mode
 * @returns LoginResult with success status and tokens
 */
export async function loginToCursor(
  credentials: CursorCredentials,
  profileDir?: string,
  options: { headless?: boolean } = {}
): Promise<LoginResult> {
  const { headless = true } = options

  let browser: Browser | null = null
  let context: BrowserContext | null = null

  try {
    console.log('🔐 Starting Cursor login flow...')

    // Launch browser
    browser = await chromium.launch({
      headless,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })

    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    })

    const page = await context.newPage()

    // Navigate to Cursor auth page
    // Use 'domcontentloaded' instead of 'networkidle' - auth pages often have ongoing background requests
    console.log(`  📍 Navigating to ${CURSOR_AUTH_URL}`)
    await page.goto(CURSOR_AUTH_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
    // Wait a moment for any redirects to complete
    await page.waitForTimeout(2000)

    // Take screenshot for debugging
    await page.screenshot({ path: 'test-results/login-1-auth-page.png' })

    // Look for email input field
    // Cursor uses WorkOS for auth, which typically has an email-first flow
    console.log('  ✉️  Looking for email input...')
    const emailInput = await page.waitForSelector(
      'input[type="email"], input[name="email"], input[placeholder*="email" i]',
      { timeout: LOGIN_TIMEOUT }
    )

    if (!emailInput) {
      throw new Error('Could not find email input field')
    }

    // Enter email
    console.log(`  ✉️  Entering email: ${credentials.email}`)
    await emailInput.fill(credentials.email)
    await page.screenshot({ path: 'test-results/login-2-email-entered.png' })

    // Click continue/next button
    const continueButton = await page.waitForSelector(
      'button[type="submit"], button:has-text("Continue"), button:has-text("Next"), button:has-text("Sign in")',
      { timeout: 5000 }
    )
    if (continueButton) {
      await continueButton.click()
      await page.waitForTimeout(1000)
    }

    await page.screenshot({ path: 'test-results/login-3-after-email.png' })

    // Wait for password field (WorkOS shows password after email)
    console.log('  🔑 Looking for password input...')
    const passwordInput = await page.waitForSelector(
      'input[type="password"], input[name="password"]',
      { timeout: LOGIN_TIMEOUT }
    )

    if (!passwordInput) {
      throw new Error('Could not find password input field')
    }

    // Enter password
    console.log('  🔑 Entering password...')
    await passwordInput.fill(credentials.password)
    await page.screenshot({ path: 'test-results/login-4-password-entered.png' })

    // Click sign in button
    const signInButton = await page.waitForSelector(
      'button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Continue")',
      { timeout: 5000 }
    )
    if (signInButton) {
      await signInButton.click()
    }

    // Wait for redirect or success indication
    console.log('  ⏳ Waiting for authentication to complete...')
    await page.waitForTimeout(3000)
    await page.screenshot({ path: 'test-results/login-5-after-submit.png' })

    // Check for success - look for session token in cookies
    const cookies = await context.cookies()
    const sessionCookie = cookies.find(
      (c) =>
        c.name.includes('CursorSession') ||
        c.name.includes('WorkosCursorSessionToken') ||
        c.name.includes('session')
    )

    if (sessionCookie) {
      console.log(
        `  ✅ Login successful! Session cookie: ${sessionCookie.name}`
      )
      return {
        success: true,
        token: sessionCookie.value,
        email: credentials.email,
      }
    }

    // Alternative: Check if we're on a success page or redirected
    const currentUrl = page.url()
    console.log(`  📍 Current URL: ${currentUrl}`)

    // Check for error messages
    const errorElement = await page.$(
      '.error, [class*="error"], [role="alert"]'
    )
    if (errorElement) {
      const errorText = await errorElement.textContent()
      throw new Error(`Login failed: ${errorText}`)
    }

    // If we got here, check if login was successful by looking at the page state
    const pageContent = await page.content()
    if (
      pageContent.includes('success') ||
      pageContent.includes('authenticated') ||
      currentUrl.includes('success')
    ) {
      console.log('  ✅ Login appears successful based on page content')
      return {
        success: true,
        email: credentials.email,
      }
    }

    // Try to extract token from local storage or page state
    const localStorage = await page.evaluate(() => {
      const items: Record<string, string> = {}
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i)
        if (key) {
          items[key] = window.localStorage.getItem(key) || ''
        }
      }
      return items
    })

    console.log('  📦 LocalStorage keys:', Object.keys(localStorage))

    // Look for token in localStorage
    const tokenKey = Object.keys(localStorage).find(
      (k) => k.includes('token') || k.includes('session') || k.includes('auth')
    )
    if (tokenKey) {
      console.log(`  ✅ Found token in localStorage: ${tokenKey}`)
      return {
        success: true,
        token: localStorage[tokenKey],
        email: credentials.email,
      }
    }

    // If we still don't have a token, try waiting for cursor:// protocol redirect
    console.log('  ⏳ Waiting for redirect...')
    try {
      await page.waitForURL(/cursor:\/\/|localhost|success/, { timeout: 10000 })
      const finalUrl = page.url()
      console.log(`  📍 Redirected to: ${finalUrl}`)

      // Extract token from URL if present
      const urlParams = new URL(finalUrl).searchParams
      const tokenFromUrl = urlParams.get('token') || urlParams.get('code')
      if (tokenFromUrl) {
        const loginResult: LoginResult = {
          success: true,
          token: tokenFromUrl,
          email: credentials.email,
        }

        // Inject auth into Cursor DB if profileDir provided
        if (profileDir && tokenFromUrl) {
          try {
            await injectAuthIntoCursorDb(profileDir, {
              token: tokenFromUrl,
              email: credentials.email,
            })
          } catch (injectError) {
            const injectErrorMessage =
              injectError instanceof Error
                ? injectError.message
                : String(injectError)
            return {
              success: false,
              error: `Auth obtained but injection failed: ${injectErrorMessage}`,
            }
          }
        }

        return loginResult
      }
    } catch {
      console.log('  ⚠️  No redirect detected')
    }

    await page.screenshot({ path: 'test-results/login-6-final-state.png' })

    return {
      success: false,
      error: 'Could not detect successful login - no session token found',
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error(`  ❌ Login failed: ${errorMessage}`)
    return {
      success: false,
      error: errorMessage,
    }
  } finally {
    if (context) {
      await context.close()
    }
    if (browser) {
      await browser.close()
    }
  }
}

/**
 * Injects authentication data into Cursor's state.vscdb database.
 *
 * @param profileDir - Path to Cursor's profile directory
 * @param authData - Authentication data to inject
 */
export async function injectAuthIntoCursorDb(
  profileDir: string,
  authData: { token: string; email: string }
): Promise<void> {
  const dbPath = path.join(profileDir, 'User', 'globalStorage', 'state.vscdb')

  console.log(`📝 Injecting auth into: ${dbPath}`)

  // Ensure directory exists
  const dbDir = path.dirname(dbPath)
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true })
  }

  // Open or create database
  const db = new Database(dbPath)

  try {
    // Create ItemTable if it doesn't exist (Cursor's schema)
    db.exec(`
      CREATE TABLE IF NOT EXISTS ItemTable (
        key TEXT UNIQUE ON CONFLICT REPLACE,
        value TEXT
      )
    `)

    // Insert auth data
    // These keys match what Cursor expects
    const authEntries = [
      {
        key: 'cursorAuth/accessToken',
        value: JSON.stringify({ token: authData.token }),
      },
      {
        key: 'cursorAuth/email',
        value: JSON.stringify(authData.email),
      },
      {
        key: 'cursorAuth/cachedSignUpType',
        value: JSON.stringify('EMAIL'),
      },
    ]

    const insertStmt = db.prepare(
      'INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)'
    )

    for (const entry of authEntries) {
      insertStmt.run(entry.key, entry.value)
      console.log(`  ✅ Inserted: ${entry.key}`)
    }

    console.log('✅ Auth data injected successfully')
  } finally {
    db.close()
  }
}

/**
 * Check if Cursor credentials are available in environment variables.
 */
export function hasCredentialsInEnv(): boolean {
  return !!(process.env.CURSOR_EMAIL && process.env.CURSOR_PASSWORD)
}

/**
 * Get Cursor credentials from environment variables.
 */
export function getCredentialsFromEnv(): CursorCredentials | null {
  if (!hasCredentialsInEnv()) {
    return null
  }
  return {
    email: process.env.CURSOR_EMAIL!,
    password: process.env.CURSOR_PASSWORD!,
  }
}
