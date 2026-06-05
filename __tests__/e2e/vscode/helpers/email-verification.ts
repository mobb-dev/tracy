/**
 * Email Verification Helper
 *
 * Fetches verification codes from email via IMAP.
 * Used for GitHub Device Verification during OAuth flow.
 */

import { setTimeout as sleep } from 'node:timers/promises'

import { ImapFlow } from 'imapflow'
import * as qp from 'quoted-printable'

type EmailVerificationParams = {
  email: string
  password: string
  fromEmailEndsWith: string
  toEmail: string
  subjectContent: string
  verificationCodeRegex: RegExp
  timeoutMs?: number
  imapHost?: string
  imapPort?: number
  /**
   * Ignore emails older than this. Set to just before the login that triggered
   * the email so a STALE verification email from a previous run/attempt (still
   * inside the recent window) can't be picked up and rejected by GitHub.
   */
  notBefore?: Date
}

// Only consider envelopes newer than this; the verification email is always the
// freshest. Keeps the matching window tight and avoids stale codes.
const RECENT_WINDOW_MS = 5 * 60 * 1000
// How many of the newest messages to scan envelopes for (cheap — no body).
const ENVELOPE_SCAN_COUNT = 30
// Poll cadence while waiting for the email to land.
const POLL_INTERVAL_MS = 4000

/**
 * Fetch a verification code from email via IMAP.
 *
 * Performance: the verification email can take a few seconds to arrive, so we
 * POLL rather than sleep-then-search-once. Each poll fetches only lightweight
 * ENVELOPES (no body) for the newest messages, finds the one matching email,
 * and downloads the full `source` for THAT message alone. Downloading full
 * RFC822 source for dozens of messages is what made this slow (minutes on a
 * busy Gmail inbox); scanning envelopes first keeps each poll fast.
 *
 * Supports Gmail / Google Workspace (imap.gmail.com, App Password) or any IMAP
 * host via IMAP_HOST / IMAP_PORT.
 */
export async function getVerificationCodeFromImapMail({
  email,
  password,
  fromEmailEndsWith,
  toEmail,
  subjectContent,
  verificationCodeRegex,
  timeoutMs = 90000,
  imapHost,
  imapPort,
  notBefore,
}: EmailVerificationParams): Promise<string[]> {
  const host = imapHost || process.env.IMAP_HOST || 'imap.gmail.com'
  const port = imapPort || parseInt(process.env.IMAP_PORT || '993', 10)

  console.log(`[EmailVerification] Connecting to IMAP: ${host}:${port}`)
  console.log(`[EmailVerification] User: ${email}`)

  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user: email, pass: password },
    logger: false,
  })

  const codes: string[] = []

  await client.connect()
  console.log('[EmailVerification] IMAP connected; polling for code...')
  try {
    const lock = await client.getMailboxLock('INBOX')
    try {
      const deadline = Date.now() + timeoutMs
      let attempt = 0
      while (codes.length === 0 && Date.now() < deadline) {
        attempt++
        const cutoff = notBefore ?? new Date(Date.now() - RECENT_WINDOW_MS)
        const status = await client.status('INBOX', { messages: true, uidNext: true })
        const uidNext = status.uidNext ?? 1
        const start = uidNext > ENVELOPE_SCAN_COUNT ? uidNext - ENVELOPE_SCAN_COUNT : 1

        // Pass 1 — cheap: envelopes only (no body download). Collect matching
        // messages with their dates so we can prefer the NEWEST one — a stale
        // verification email from a prior run/attempt is otherwise picked up and
        // rejected by GitHub.
        const candidates: Array<{ uid: number; date: Date }> = []
        for await (const msg of client.fetch(
          `${start}:*`,
          { envelope: true, uid: true },
          { uid: true }
        )) {
          const env = msg.envelope
          const from = env?.from?.[0]?.address
          const to = env?.to?.[0]?.address
          if (
            env?.date &&
            env.date >= cutoff &&
            from?.endsWith(fromEmailEndsWith) &&
            to === toEmail &&
            env.subject === subjectContent &&
            msg.uid
          ) {
            candidates.push({ uid: msg.uid, date: env.date })
          }
        }
        candidates.sort((a, b) => b.date.getTime() - a.date.getTime())

        // Pass 2 — download source ONLY for matches, newest first; take the
        // first code found and stop.
        for (const { uid } of candidates) {
          const full = await client.fetchOne(
            String(uid),
            { source: true },
            { uid: true }
          )
          if (full && full.source) {
            const decoded = qp.decode(full.source.toString())
            const match = decoded.match(verificationCodeRegex)
            if (match && match[1]) {
              console.log(
                `[EmailVerification] Found code on poll #${attempt} (uid ${uid})`
              )
              codes.push(match[1])
              break
            }
          }
        }

        if (codes.length === 0) {
          await sleep(POLL_INTERVAL_MS)
        }
      }
    } finally {
      lock.release()
    }
  } finally {
    await client.logout()
  }

  if (codes.length === 0) {
    console.log(
      `[EmailVerification] No verification code found within ${timeoutMs}ms`
    )
  }

  return codes
}

/**
 * Load email credentials from environment variables
 *
 * Priority:
 * 1. MOBB_CI_TEST_EMAIL_USERNAME/PASSWORD (dedicated email test account)
 *    - This is the RECOMMENDED option for CI
 *    - For Gmail: Use the email + App Password (not regular password)
 *    - For Google Workspace: Same as Gmail
 *
 * 2. PLAYWRIGHT_GH_CLOUD_USER_EMAIL/PASSWORD (GitHub account)
 *    - WARNING: This is a FALLBACK that usually WON'T WORK!
 *    - GitHub password is NOT the same as email IMAP password
 *    - Only works if GitHub and email use the exact same password (unlikely)
 */
export function loadEmailCredentials(): {
  email: string
  password: string
} | null {
  // Priority 1: Dedicated test email account (RECOMMENDED)
  const mobbEmail = process.env.MOBB_CI_TEST_EMAIL_USERNAME
  const mobbPassword = process.env.MOBB_CI_TEST_EMAIL_PASSWORD

  if (mobbEmail && mobbPassword) {
    console.log('[EmailVerification] Using MOBB_CI_TEST_EMAIL credentials')
    console.log(`[EmailVerification]   Email: ${mobbEmail}`)
    return { email: mobbEmail, password: mobbPassword }
  }

  // Priority 2: GitHub account (FALLBACK - usually won't work)
  const ghEmail = process.env.PLAYWRIGHT_GH_CLOUD_USER_EMAIL
  const ghPassword = process.env.PLAYWRIGHT_GH_CLOUD_USER_PASSWORD

  if (ghEmail && ghPassword) {
    console.log(
      '[EmailVerification] ⚠️  WARNING: Falling back to PLAYWRIGHT_GH_CLOUD_USER credentials'
    )
    console.log(
      '[EmailVerification] ⚠️  This uses GitHub password for IMAP - likely to FAIL!'
    )
    console.log(
      '[EmailVerification] ⚠️  To fix: Set MOBB_CI_TEST_EMAIL_USERNAME/PASSWORD secrets'
    )
    console.log(
      '[EmailVerification] ⚠️  For Gmail/Google Workspace: Use an App Password'
    )
    console.log(`[EmailVerification]   Email: ${ghEmail}`)
    return { email: ghEmail, password: ghPassword }
  }

  console.log('[EmailVerification] ❌ No email credentials found!')
  console.log('[EmailVerification]   Required secrets:')
  console.log(
    '[EmailVerification]   - MOBB_CI_TEST_EMAIL_USERNAME (email address)'
  )
  console.log(
    '[EmailVerification]   - MOBB_CI_TEST_EMAIL_PASSWORD (IMAP/App Password)'
  )

  return null
}
