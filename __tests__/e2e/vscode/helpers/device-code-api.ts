/**
 * GitHub Device Code Flow API
 *
 * Low-level API functions for GitHub's Device Flow OAuth.
 * See: https://docs.github.com/en/developers/apps/building-oauth-apps/authorizing-oauth-apps#device-flow
 */

// VS Code's GitHub OAuth client ID (public, from VS Code source)
export const VSCODE_GITHUB_CLIENT_ID = '01ab8ac9400c4e429b23'

// Scopes needed for Copilot
export const OAUTH_SCOPES = 'read:user user:email copilot'

export type DeviceCodeResponse = {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export type AccessTokenResponse = {
  access_token?: string
  token_type?: string
  scope?: string
  error?: string
  error_description?: string
}

/**
 * Request a device code from GitHub
 */
export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  console.log('[DeviceFlow] Requesting device code from GitHub...')

  const response = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: VSCODE_GITHUB_CLIENT_ID,
      scope: OAUTH_SCOPES,
    }),
  })

  const data = (await response.json()) as DeviceCodeResponse

  if (!data.device_code || !data.user_code) {
    throw new Error(`Failed to get device code: ${JSON.stringify(data)}`)
  }

  console.log(`[DeviceFlow] Got device code!`)
  console.log(`[DeviceFlow]   User code: ${data.user_code}`)
  console.log(`[DeviceFlow]   Verification URL: ${data.verification_uri}`)
  console.log(`[DeviceFlow]   Expires in: ${data.expires_in}s`)

  return data
}

/**
 * Poll GitHub for the access token
 */
export async function pollForAccessToken(
  deviceCode: string,
  interval: number,
  expiresIn: number
): Promise<string> {
  console.log('[DeviceFlow] Polling for access token...')

  const startTime = Date.now()
  const expiresAt = startTime + expiresIn * 1000

  while (Date.now() < expiresAt) {
    await new Promise((r) => setTimeout(r, interval * 1000))

    const response = await fetch(
      'https://github.com/login/oauth/access_token',
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: VSCODE_GITHUB_CLIENT_ID,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      }
    )

    const data = (await response.json()) as AccessTokenResponse

    if (data.access_token) {
      console.log('[DeviceFlow] Got access token!')
      return data.access_token
    }

    if (data.error === 'authorization_pending') {
      console.log('[DeviceFlow]   Still waiting for user authorization...')
      continue
    }

    if (data.error === 'slow_down') {
      console.log('[DeviceFlow]   Rate limited, increasing interval...')
      interval += 5
      continue
    }

    if (data.error === 'expired_token') {
      throw new Error('Device code expired. User did not authorize in time.')
    }

    if (data.error === 'access_denied') {
      throw new Error('User denied the authorization request.')
    }

    throw new Error(
      `Unexpected error: ${data.error} - ${data.error_description}`
    )
  }

  throw new Error('Timeout waiting for user authorization')
}
