/**
 * Email Verification Helper
 *
 * Fetches verification codes from email via IMAP.
 * Used for GitHub Device Verification during OAuth flow.
 */

import { FetchMessageObject, ImapFlow } from 'imapflow'
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
}

/**
 * Fetch verification code from email via IMAP
 *
 * Connects to IMAP server and searches recent emails for a verification code.
 * Used for GitHub's "Verify your device" email flow.
 *
 * Supports:
 * - Gmail (imap.gmail.com) - requires App Password if 2FA enabled
 * - Google Workspace (imap.gmail.com) - same as Gmail
 * - Other providers via IMAP_HOST env var
 */
export async function getVerificationCodeFromImapMail({
  email,
  password,
  fromEmailEndsWith,
  toEmail,
  subjectContent,
  verificationCodeRegex,
  timeoutMs = 10000,
  imapHost,
  imapPort,
}: EmailVerificationParams): Promise<string[]> {
  // Use configured host or env var or default to Gmail
  const host = imapHost || process.env.IMAP_HOST || 'imap.gmail.com'
  const port = imapPort || parseInt(process.env.IMAP_PORT || '993', 10)

  console.log(`[EmailVerification] Connecting to IMAP: ${host}:${port}`)
  console.log(`[EmailVerification] User: ${email}`)

  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: {
      user: email,
      pass: password,
    },
    logger: false, // Disable verbose logging
  })

  // Wait for email to arrive
  console.log(
    `[EmailVerification] Waiting ${timeoutMs}ms for email to arrive...`
  )
  await new Promise((resolve) => setTimeout(resolve, timeoutMs))

  const codes: string[] = []

  try {
    console.log('[EmailVerification] Attempting IMAP connection...')
    await client.connect()
    console.log('[EmailVerification] IMAP connected successfully')

    const lock = await client.getMailboxLock('INBOX')
    console.log('[EmailVerification] Got mailbox lock on INBOX')

    try {
      const status = await client.status('INBOX', {
        messages: true,
        recent: true,
        uidNext: true,
        uidValidity: true,
        unseen: true,
        highestModseq: true,
      })

      if (!status.uidNext) {
        throw new Error('Email status retrieval failed')
      }

      // Fetch last 50 messages
      const fetchMessages = client.fetch(
        `${status.uidNext > 50 ? status.uidNext - 50 : 1}:*`,
        {
          envelope: true,
          source: true,
          flags: true,
          labels: true,
          uid: true,
          bodyStructure: true,
        }
      )

      const messages: FetchMessageObject[] = []
      for await (const msg of fetchMessages) {
        messages.unshift(msg) // Most recent first
      }

      for (const msg of messages) {
        const envelope = msg?.envelope
        const source = msg?.source
        const from = envelope?.from?.[0]?.address
        const to = envelope?.to?.[0]?.address
        const subject = envelope?.subject
        const date = envelope?.date

        if (!source || !date || !from || !to || !subject) {
          continue
        }

        const decodedSource = qp.decode(source.toString())
        const fiveMinutesAgo = new Date(Date.now() - 1000 * 60 * 5)

        // Check if this is a recent verification email
        if (
          date > fiveMinutesAgo &&
          from.endsWith(fromEmailEndsWith) &&
          to === toEmail &&
          subject === subjectContent
        ) {
          const match = decodedSource.match(verificationCodeRegex)
          if (match && match[1]) {
            console.log(`[EmailVerification] Found code in email from ${date}`)
            codes.push(match[1])
          }
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
      '[EmailVerification] No verification code found in recent emails'
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
