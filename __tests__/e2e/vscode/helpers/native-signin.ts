/**
 * Native VS Code GitHub Sign-In Automation
 *
 * Drives VS Code's OWN "Sign in with GitHub" flow instead of injecting a
 * pre-built session into state.vscdb. This is mandatory on Windows VS Code
 * >=1.123: there the secret store is encrypted with a machine/installation-
 * bound key (Chromium os_crypt AES-256-GCM, key DPAPI-wrapped in `Local State`),
 * and `--password-store=basic` is a no-op — so a peanuts/v10 secret synthesized
 * off-box can never be decrypted (`secrets.get` returns empty → "Got 0
 * sessions"). Letting VS Code perform the sign-in means VS Code encrypts and
 * stores the session itself, with a key it can read back.
 *
 * Mechanism:
 *  1. Override `shell.openExternal` in the Electron MAIN process so the loopback
 *     OAuth URL VS Code wants to open is captured instead of handed to the OS.
 *  2. Trigger a GitHub session request (the test-only auth-trigger extension
 *     calls `authentication.getSession('github', …, {createIfNone:true})`), and
 *     click through VS Code's "Allow / Sign in" prompts.
 *  3. The captured URL is `http://127.0.0.1:<port>/signin?nonce=…`, VS Code's
 *     local server. Drive a Playwright browser through it: it 302s to
 *     github.com/login/oauth/authorize (client_id 01ab8ac9400c4e429b23, scopes
 *     read:user/user:email/repo/workflow, redirect_uri vscode.dev/redirect,
 *     state=the loopback /callback). Log in, clear device verification, click
 *     Authorize. GitHub → vscode.dev/redirect → 127.0.0.1/callback, where VS
 *     Code's server exchanges the PKCE code and stores the session.
 *
 * The browser half reuses the same GitHub login + email device-verification +
 * authorize automation proven by the device-flow path.
 */

import * as fs from 'fs'
import * as path from 'path'
import { setTimeout as sleep } from 'node:timers/promises'

import { firefox } from '@playwright/test'
import type { Browser, ElectronApplication, Page } from 'playwright'

import {
  getVerificationCodeFromImapMail,
  loadEmailCredentials,
} from './email-verification'
import type { OAuthCredentials } from './oauth-config'

const AUTH_TRIGGER_ID = 'mobb-e2e.mobb-e2e-auth-trigger'
const AUTH_TRIGGER_FOLDER = 'mobb-e2e.mobb-e2e-auth-trigger-0.0.1'

/**
 * Side-load the test-only auth-trigger extension into the disposable profile so
 * it requests a GitHub session on startup. Copies the unpacked folder and
 * registers it in `extensions.json` (cloning an existing entry's shape) so the
 * build loads it deterministically instead of relying on a folder rescan.
 */
export function installAuthTriggerExtension(extensionsDir: string): string {
  const srcDir = path.join(__dirname, 'auth-trigger-extension')
  const dest = path.join(extensionsDir, AUTH_TRIGGER_FOLDER)
  fs.cpSync(srcDir, dest, { recursive: true })

  const jsonPath = path.join(extensionsDir, 'extensions.json')
  if (fs.existsSync(jsonPath)) {
    const entries = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as Array<{
      identifier?: { id?: string }
      version?: string
      location?: { $mid?: number; path?: string; scheme?: string }
      relativeLocation?: string
      metadata?: Record<string, unknown>
    }>
    const already = entries.some((e) => e.identifier?.id === AUTH_TRIGGER_ID)
    if (!already) {
      // Clone the shape of a real entry so the location URI / fields match what
      // this VS Code build expects, then point it at our folder.
      const template = entries[0]
        ? (JSON.parse(JSON.stringify(entries[0])) as (typeof entries)[number])
        : ({} as (typeof entries)[number])
      template.identifier = { id: AUTH_TRIGGER_ID }
      template.version = '0.0.1'
      if (template.location && typeof template.location.path === 'string') {
        template.location.path = template.location.path.replace(
          /[^/\\]+$/,
          AUTH_TRIGGER_FOLDER
        )
      } else {
        template.location = {
          $mid: 1,
          path: '/' + dest.replace(/\\/g, '/').replace(/^\//, ''),
          scheme: 'file',
        }
      }
      template.relativeLocation = AUTH_TRIGGER_FOLDER
      template.metadata = {
        isApplicationScoped: false,
        isMachineScoped: false,
        isBuiltin: false,
        installedTimestamp: Date.now(),
        source: 'vsix',
      }
      entries.push(template)
      fs.writeFileSync(jsonPath, JSON.stringify(entries))
      console.log('  Registered auth-trigger extension in extensions.json')
    }
  }
  return dest
}

export type NativeSignInResult = {
  success: boolean
  error?: string
}

export type NativeSignInOptions = {
  headless?: boolean
  useFirefox?: boolean
  /** Max time to wait for VS Code to emit its loopback sign-in URL (ms). */
  captureTimeoutMs?: number
  /** Max time for the browser to complete login+authorize+callback (ms). */
  browserTimeoutMs?: number
  /**
   * Path to a Playwright storageState JSON for the GitHub sign-in browser. When
   * the file exists it is loaded so an already-logged-in github.com session
   * (cookies incl. device-trust) lets `loginToGitHub` skip the password + email
   * device-verification step. After a successful sign-in the (possibly updated)
   * state is written back to this path so the next sign-in — on a retry or a
   * later run on the same machine — reuses it. The interactive OAuth login is
   * the slowest and flakiest step, so reusing it is the single biggest
   * stability win. VS Code still performs its own loopback OAuth and stores its
   * own session; only the browser-side github.com login is cached.
   */
  storageStatePath?: string
}

const DEFAULT_CAPTURE_TIMEOUT = 45000
const DEFAULT_BROWSER_TIMEOUT = 120000

// ───────────────────────────────────────────────────────────────────────────
// Electron main-process interception
// ───────────────────────────────────────────────────────────────────────────

/**
 * Replace `shell.openExternal` in the Electron main process with a capturing
 * stub. VS Code routes `vscode.env.openExternal` through the main process, so
 * this intercepts the loopback OAuth URL without it reaching the OS browser.
 *
 * Idempotent: install this EARLY (right after the window loads) so a URL opened
 * before sign-in orchestration begins is still captured. Re-invoking preserves
 * any already-captured URLs.
 */
export async function interceptOpenExternal(
  app: ElectronApplication
): Promise<void> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as {
      __mobbCapturedUrls?: string[]
      __mobbOpenExternalHooked?: boolean
    }
    g.__mobbCapturedUrls = g.__mobbCapturedUrls ?? []
    if (g.__mobbOpenExternalHooked) return
    g.__mobbOpenExternalHooked = true
    shell.openExternal = async (url: string) => {
      const asString = typeof url === 'string' ? url : String(url)
      g.__mobbCapturedUrls!.push(asString)
      // eslint-disable-next-line no-console
      console.log(`[NativeSignIn][main] captured openExternal: ${asString}`)
      return undefined as unknown as void
    }
  })
}

async function readCapturedUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => {
    const g = globalThis as unknown as { __mobbCapturedUrls?: string[] }
    return g.__mobbCapturedUrls ?? []
  })
}

/**
 * Click VS Code's sign-in consent prompts ("Allow", "Sign in", "Continue") as
 * they appear, polling the main process until the loopback `/signin` URL is
 * captured (or timeout). Returns the URL or null.
 */
async function captureLoopbackUrl(
  app: ElectronApplication,
  mainWindow: Page,
  timeoutMs: number
): Promise<string | null> {
  const promptLabels = ['Allow', 'Sign in', 'Continue', 'Allow access', 'Yes']
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    for (const label of promptLabels) {
      try {
        const button = mainWindow.getByRole('button', { name: label })
        if (
          (await button.count()) > 0 &&
          (await button.first().isVisible().catch(() => false))
        ) {
          console.log(`[NativeSignIn] clicking VS Code prompt: "${label}"`)
          await button.first().click({ timeout: 1500 }).catch(() => {})
        }
      } catch {
        // prompt not present this tick — keep polling
      }
    }

    const urls = await readCapturedUrls(app)
    const signin = urls.find((u) => u.includes('127.0.0.1') && u.includes('/signin'))
    if (signin) {
      console.log(`[NativeSignIn] captured loopback sign-in URL: ${signin}`)
      return signin
    }

    await mainWindow.waitForTimeout(1000)
  }

  const all = await readCapturedUrls(app)
  console.log(
    `[NativeSignIn] no loopback URL within ${timeoutMs}ms (captured: ${JSON.stringify(all)})`
  )
  return null
}

// ───────────────────────────────────────────────────────────────────────────
// Browser-side GitHub automation
// ───────────────────────────────────────────────────────────────────────────

/** Log into github.com, clearing email-based device verification if prompted. */
async function loginToGitHub(
  page: Page,
  credentials: OAuthCredentials
): Promise<void> {
  console.log('[NativeSignIn] navigating to GitHub login...')
  await page.goto('https://github.com/login', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)

  const content = await page.content()
  if (content.includes('Just a moment') || content.includes('Cloudflare')) {
    throw new Error('Cloudflare challenge detected. Cannot automate.')
  }

  const loginField = page.locator('input[name="login"]')
  if (!(await loginField.isVisible({ timeout: 5000 }).catch(() => false))) {
    // Already authenticated (session cookie present) — nothing to do.
    console.log('[NativeSignIn] no login form — already authenticated')
    return
  }

  console.log('[NativeSignIn] entering credentials...')
  await loginField.fill(credentials.email)
  await page.locator('input[name="password"]').fill(credentials.password)
  // Stamp the login so the email helper only accepts the device-verification
  // email triggered by THIS login — a stale code from a prior run/attempt is
  // otherwise grabbed and rejected by GitHub (login never authenticates).
  const loginAt = new Date()
  await page.locator('input[type="submit"]').click()
  await page.waitForTimeout(3000)

  const afterLoginUrl = page.url()
  console.log(`[NativeSignIn] after login - URL: ${afterLoginUrl}`)
  await page
    .screenshot({ path: 'test-results/native-00-after-login.png', fullPage: true })
    .catch(() => {})

  // GitHub email device verification (not TOTP 2FA).
  if (afterLoginUrl.includes('/sessions/verified-device')) {
    console.log('[NativeSignIn] GitHub device verification detected')
    const emailCreds = loadEmailCredentials()
    if (!emailCreds) {
      throw new Error(
        'GitHub device verification requires email access. Set ' +
          'MOBB_CI_TEST_EMAIL_USERNAME and MOBB_CI_TEST_EMAIL_PASSWORD.'
      )
    }
    const codes = await getVerificationCodeFromImapMail({
      email: emailCreds.email,
      password: emailCreds.password,
      fromEmailEndsWith: 'noreply@github.com',
      toEmail: credentials.email,
      subjectContent: '[GitHub] Please verify your device',
      verificationCodeRegex: /Verification code: ([0-9]{6})/,
      // Poll deadline — the helper returns as soon as the email lands.
      timeoutMs: 90000,
      // Only accept the email this login triggered (30s skew buffer).
      notBefore: new Date(loginAt.getTime() - 30000),
    })
    if (codes.length === 0) {
      throw new Error('No GitHub device-verification code found in email.')
    }
    console.log(`[NativeSignIn] got verification code: ${codes[0]}`)
    const codeInput = page.locator('input[name="otp"], input#otp')
    if (!(await codeInput.isVisible({ timeout: 5000 }).catch(() => false))) {
      throw new Error('Could not find device-verification code input.')
    }
    await codeInput.fill(codes[0])
    await page.waitForTimeout(2000)
    if (page.url().includes('verified-device')) {
      await page
        .locator('button[type="submit"], input[type="submit"]')
        .first()
        .click()
        .catch(() => {})
      await page.waitForTimeout(3000)
    }
    console.log('[NativeSignIn] submitted device verification')
  }

  // TOTP 2FA is not automatable — the test account must not have it.
  const totp = page.locator('input#app_totp')
  if (await totp.isVisible({ timeout: 2000 }).catch(() => false)) {
    throw new Error(
      '2FA (TOTP/authenticator) required. The test account must not have 2FA enabled.'
    )
  }

  const errorMsg = page.locator('.flash-error, .js-flash-alert')
  if (await errorMsg.isVisible({ timeout: 1000 }).catch(() => false)) {
    throw new Error(`Login failed: ${await errorMsg.textContent()}`)
  }
}

/**
 * True once the browser has left github.com for VS Code's loopback callback or
 * the vscode.dev redirect bounce. Checks the URL **hostname** — NOT a substring
 * — because the github.com authorize/select_account URLs carry `redirect_uri`
 * and `state` query params that literally contain "vscode.dev" and "127.0.0.1",
 * which would otherwise be mistaken for having reached the callback.
 */
function reachedCallback(rawUrl: string): boolean {
  let host = ''
  try {
    host = new URL(rawUrl).hostname
  } catch {
    return false
  }
  return host === '127.0.0.1' || host === 'localhost' || host.endsWith('vscode.dev')
}

/**
 * On the OAuth pages, click "Continue" (account picker, `prompt=select_account`)
 * and the green "Authorize" button until the browser redirects to VS Code's
 * loopback callback. Returns true once the callback/redirect host is reached.
 */
async function clickThroughAuthorize(page: Page): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt++) {
    if (page.isClosed()) {
      // Page closed after a redirect — the callback almost certainly fired.
      console.log('[NativeSignIn] page closed during authorize (callback fired)')
      return true
    }
    const url = page.url()
    const host = (() => {
      try {
        return new URL(url).hostname
      } catch {
        return '(unparseable)'
      }
    })()
    console.log(
      `[NativeSignIn] authorize step ${attempt}: host=${host} url=${url.slice(0, 90)}`
    )
    await page
      .screenshot({ path: `test-results/native-1${attempt}-authorize.png` })
      .catch(() => {})

    // Left GitHub for the loopback callback / vscode.dev bounce → done.
    if (reachedCallback(url)) {
      console.log('[NativeSignIn] reached callback/redirect host')
      return true
    }

    // We should only be on github.com here. Anywhere else (e.g. a social-login
    // redirect to accounts.google.com) means the session wasn't established —
    // bail rather than clicking stray "Continue with …" buttons.
    if (host !== 'github.com') {
      console.log(`[NativeSignIn] unexpected host ${host}; not authenticated, aborting`)
      return false
    }
    // The bare login page (vs the /login/oauth/authorize consent) means we are
    // not signed in — authorization can't proceed.
    let pathname = ''
    try {
      pathname = new URL(url).pathname
    } catch {
      /* keep empty */
    }
    if (pathname === '/login' || pathname === '/session') {
      console.log('[NativeSignIn] back at GitHub login; not authenticated, aborting')
      return false
    }

    // Click the page's primary (green) action: "Continue" on the account-select
    // page ("Authorize Visual Studio Code" / "Signed in as <user>"), or
    // "Authorize <app>" on the consent page. It can render as a <button> or an
    // <a>, so try several locators. The text filter avoids secondary actions
    // ("Use a different account", "Cancel") and social-login ("Continue with …").
    const primaryCandidates = [
      page
        .locator('a.btn-primary, button.btn-primary')
        .filter({ hasText: /^(authorize|continue)\b/i })
        .first(),
      page.locator('button[name="authorize"][value="1"]').first(),
      page.getByRole('button', { name: /^(authorize|continue)\b/i }).first(),
      page.getByRole('link', { name: /^(authorize|continue)\b/i }).first(),
    ]
    let clicked = false
    for (const cand of primaryCandidates) {
      if (await cand.isVisible({ timeout: 800 }).catch(() => false)) {
        const label = ((await cand.textContent().catch(() => '')) || '')
          .trim()
          .slice(0, 40)
        console.log(`[NativeSignIn] clicking primary action: "${label}"`)
        await cand.scrollIntoViewIfNeeded().catch(() => {})
        await cand.click().catch(() => {})
        clicked = true
        break
      }
    }
    // Wait, then re-loop to detect the redirect to the loopback callback.
    await page.waitForTimeout(clicked ? 2500 : 1500)
  }

  console.log('[NativeSignIn] authorize loop exhausted')
  await page
    .screenshot({ path: 'test-results/native-1x-no-authorize.png', fullPage: true })
    .catch(() => {})
  return reachedCallback(page.url())
}

/**
 * Drive a browser from the captured loopback `/signin` URL all the way to the
 * `127.0.0.1/callback`, so VS Code's local server completes the token exchange.
 */
async function driveBrowserSignIn(
  signinUrl: string,
  credentials: OAuthCredentials,
  options: NativeSignInOptions
): Promise<void> {
  console.log('[NativeSignIn] launching browser for GitHub sign-in...')
  const browser: Browser = await firefox.launch({
    headless: options.headless ?? true,
  })
  // Hard ceiling on the whole browser flow. Without it a single step — observed
  // hanging for ~7.5 min after the device-verification code was fetched — runs
  // until the per-test timeout kills the Electron app, which (a) burns the whole
  // test budget and (b) defeats the in-process retry, since attempt 1 never
  // yields. Bounding here lets a hung attempt abort fast so the caller's retry
  // (with cached cookies) can finish inside the same test. The browser is closed
  // in `finally` on either path, so a timeout never leaks a Firefox process.
  const timeoutMs = options.browserTimeoutMs ?? DEFAULT_BROWSER_TIMEOUT
  const abort = new AbortController()
  try {
    const work = (async () => {
      // Reuse a cached github.com session if we have one — `loginToGitHub` then
      // short-circuits (no password, no email device-verification), which is the
      // slow/flaky path we most want to avoid on retries and repeat runs.
      const reuseState =
        options.storageStatePath && fs.existsSync(options.storageStatePath)
      if (reuseState) {
        console.log(
          `[NativeSignIn] reusing cached GitHub session: ${options.storageStatePath}`
        )
      }
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        ...(reuseState ? { storageState: options.storageStatePath } : {}),
      })
      // ROOT-CAUSE GUARD: Playwright's default action/navigation timeout is 0
      // (unlimited). The device-verification step (`codeInput.fill` + submit
      // `click`) was observed hanging ~7.5 min — the GitHub OTP element is
      // momentarily not actionable and, with no ceiling, the action waits until
      // the per-test timeout kills the app. Bounding every action in THIS
      // (Firefox) sign-in context makes a stuck interaction fail in ~30s, so the
      // in-process retry recovers in seconds instead of burning the test budget.
      // Scoped to this context only — the Electron/VS Code page keeps its own
      // explicit timeouts (see __tests__/e2e/LESSONS.md on why defaults are
      // unreliable there). Explicit per-call timeouts still override these.
      context.setDefaultTimeout(30000)
      context.setDefaultNavigationTimeout(45000)
      const page = await context.newPage()

      // 1) Establish a logged-in GitHub session (handles device verification).
      await loginToGitHub(page, credentials)

      // Persist the (now logged-in) github.com session so the next sign-in skips
      // the interactive login. Best-effort: a failure to save must not fail the
      // sign-in itself. Done right after login — before the OAuth authorize
      // dance, whose page redirects can close the context out from under us.
      if (options.storageStatePath) {
        try {
          fs.mkdirSync(path.dirname(options.storageStatePath), {
            recursive: true,
          })
          await context.storageState({ path: options.storageStatePath })
          console.log(
            `[NativeSignIn] saved GitHub session to ${options.storageStatePath}`
          )
        } catch (err) {
          console.log(`[NativeSignIn] could not save GitHub session: ${err}`)
        }
      }

      // 2) Hit VS Code's loopback /signin → 302 to GitHub OAuth authorize.
      console.log('[NativeSignIn] navigating to loopback /signin URL...')
      await page
        .goto(signinUrl, { waitUntil: 'domcontentloaded' })
        .catch(() => {})
      await page.waitForTimeout(1500)

      // 3) Click through the authorize/consent UI.
      const authorized = await clickThroughAuthorize(page)
      if (!authorized) {
        throw new Error('Failed to authorize VS Code on the GitHub OAuth page.')
      }

      // 4) Follow GitHub → vscode.dev/redirect → 127.0.0.1/callback so VS Code's
      //    server receives the code. The page may close once it redirects, so all
      //    waits here tolerate a closed page — reaching the callback IS success.
      try {
        await page.waitForURL(/127\.0\.0\.1:\d+\/callback/, { timeout: 30000 })
        console.log(`[NativeSignIn] reached callback: ${page.url()}`)
      } catch {
        const finalUrl = page.isClosed() ? '(page closed)' : page.url()
        console.log(
          `[NativeSignIn] callback wait ended (final URL: ${finalUrl}); ` +
            'VS Code may have already consumed the code'
        )
      }
      // Give VS Code's local server a moment to exchange the code + persist.
      // Page-independent sleep so a closed callback page doesn't throw.
      await sleep(3000)
    })()
    // Swallow a late rejection if the timeout wins and `browser.close()` below
    // tears the flow down mid-step — otherwise it surfaces as an unhandled
    // rejection after we've already returned a failure to the caller.
    work.catch(() => {})

    const guard = sleep(timeoutMs, undefined, { signal: abort.signal }).then(
      () => {
        throw new Error(`GitHub sign-in browser flow exceeded ${timeoutMs}ms`)
      }
    )
    guard.catch(() => {})

    await Promise.race([work, guard])
  } finally {
    abort.abort() // cancel the guard timer when work wins
    await browser.close().catch(() => {})
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Orchestration
// ───────────────────────────────────────────────────────────────────────────

/**
 * Perform VS Code's native GitHub sign-in end to end. Assumes the auth-trigger
 * extension is installed (it requests the session) and VS Code is already
 * launched. Returns success once the browser has driven the OAuth callback back
 * into VS Code's loopback server.
 */
export async function performNativeVSCodeSignIn(
  app: ElectronApplication,
  mainWindow: Page,
  credentials: OAuthCredentials,
  options: NativeSignInOptions = {}
): Promise<NativeSignInResult> {
  try {
    await interceptOpenExternal(app)
    console.log('[NativeSignIn] openExternal interceptor installed')

    const signinUrl = await captureLoopbackUrl(
      app,
      mainWindow,
      options.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT
    )
    if (!signinUrl) {
      return {
        success: false,
        error: 'VS Code never opened a loopback sign-in URL',
      }
    }

    await driveBrowserSignIn(signinUrl, credentials, {
      ...options,
      browserTimeoutMs: options.browserTimeoutMs ?? DEFAULT_BROWSER_TIMEOUT,
    })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
