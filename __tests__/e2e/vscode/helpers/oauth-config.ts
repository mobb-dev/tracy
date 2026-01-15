/**
 * OAuth Configuration Helpers
 *
 * Utilities for loading OAuth credentials and storing tokens.
 */

import * as fs from 'fs'
import * as path from 'path'

import { OAUTH_SCOPES, VSCODE_GITHUB_CLIENT_ID } from './device-code-api'

export type OAuthCredentials = {
  email: string
  password: string
}

/**
 * Load credentials from environment variables or .env file
 *
 * Priority:
 * 1. Direct environment variables (for CI/Docker)
 * 2. .env files (for local development)
 */
export function loadCredentialsFromEnv(
  envPath?: string
): OAuthCredentials | null {
  // PRIORITY 1: Check direct environment variables first (CI/Docker)
  const envEmail = process.env.PLAYWRIGHT_GH_CLOUD_USER_EMAIL
  const envPassword = process.env.PLAYWRIGHT_GH_CLOUD_USER_PASSWORD

  if (envEmail && envPassword) {
    console.log('[DeviceFlow] Found credentials from environment variables')
    console.log(`[DeviceFlow]   Email: ${envEmail}`)
    return {
      email: envEmail,
      password: envPassword,
    }
  }

  // PRIORITY 2: Try .env files (local development)
  // Find the repo root by looking for pnpm-workspace.yaml
  let repoRoot = process.cwd()
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(repoRoot, 'pnpm-workspace.yaml'))) {
      break
    }
    repoRoot = path.dirname(repoRoot)
  }

  const possiblePaths = [
    envPath,
    path.join(repoRoot, '__tests__/.env'),
    path.join(repoRoot, 'clients/tracer_ext/__tests__/.env'),
    path.join(repoRoot, 'clients/tracer_ext/.env'),
    path.join(__dirname, '../../../../../__tests__/.env'),
    path.join(__dirname, '../../../.env'),
  ].filter(Boolean) as string[]

  let filePath: string | null = null
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      filePath = p
      console.log(`[DeviceFlow] Found credentials file at: ${p}`)
      break
    }
  }

  if (!filePath) {
    return null
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  const emailMatch = content.match(/PLAYWRIGHT_GH_CLOUD_USER_EMAIL="([^"]+)"/)
  const passMatch = content.match(/PLAYWRIGHT_GH_CLOUD_USER_PASSWORD="([^"]+)"/)

  if (!emailMatch || !passMatch) {
    console.log(
      '[DeviceFlow] Credentials file found but missing required fields'
    )
    return null
  }

  console.log(`[DeviceFlow]   Email: ${emailMatch[1]}`)
  return {
    email: emailMatch[1],
    password: passMatch[1],
  }
}

/**
 * Store token in a format that can be injected into VS Code
 */
export function storeOAuthToken(token: string, outputPath?: string): void {
  const defaultPath = path.join(__dirname, '../github-oauth-token.json')
  const filePath = outputPath || defaultPath

  const tokenData = {
    accessToken: token,
    scopes: OAUTH_SCOPES.split(' '),
    createdAt: new Date().toISOString(),
    clientId: VSCODE_GITHUB_CLIENT_ID,
    vsCodeFormat: {
      id: `github-${Date.now()}`,
      accessToken: token,
      account: {
        label: 'automated-test',
        id: 'automated',
      },
      scopes: OAUTH_SCOPES.split(' '),
    },
  }

  fs.writeFileSync(filePath, JSON.stringify(tokenData, null, 2))
  console.log(`[DeviceFlow] Token stored at: ${filePath}`)
}
