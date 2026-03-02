import { getAuthenticatedGQLClient } from '../mobbdev_src/commands/handleMobbLogin'
import { GQLClient } from '../mobbdev_src/features/analysis/graphql'
import { getConfig } from './config'
import { logger } from './logger'

let cachedClient: GQLClient | null = null
let cachedClientPromise: Promise<GQLClient> | null = null

/**
 * Returns a singleton authenticated GQL client.
 * Multiple concurrent callers share the same in-flight auth request.
 * The client is cached for the extension lifetime and only recreated
 * on explicit invalidation (e.g., auth failure).
 */
export async function createGQLClient(): Promise<GQLClient> {
  if (cachedClient) {
    return cachedClient
  }

  // Dedupe concurrent calls — all callers share the same in-flight promise
  if (cachedClientPromise) {
    return cachedClientPromise
  }

  cachedClientPromise = (async () => {
    const config = getConfig()
    logger.info('Creating GQL client')
    try {
      const client = await getAuthenticatedGQLClient({
        apiUrl: config.apiUrl,
        webAppUrl: config.webAppUrl,
      })
      cachedClient = client
      return client
    } finally {
      cachedClientPromise = null
    }
  })()

  return cachedClientPromise
}

/**
 * Invalidates the cached GQL client, forcing re-auth on next call.
 * Call this when an auth error is detected.
 */
export function invalidateGQLClient(): void {
  cachedClient = null
  cachedClientPromise = null
}

/**
 * Check if an error is an auth error and invalidate the cached GQL client
 * if so, forcing re-auth on the next call.
 *
 * Hasura returns HTTP 200 for auth errors, so we check the GraphQL error
 * extensions (code: "access-denied") instead of the HTTP status.
 */
export function invalidateOnAuthError(err: unknown): void {
  const response = (
    err as {
      response?: {
        errors?: Array<{
          extensions?: { code?: string }
          message?: string
        }>
      }
    }
  )?.response
  const hasAuthError =
    response?.errors?.some(
      (e) =>
        e.extensions?.code === 'access-denied' ||
        e.message?.includes('Authentication hook unauthorized')
    ) ?? false

  if (hasAuthError) {
    logger.info(
      'Auth error detected (access-denied), invalidating cached GQL client'
    )
    invalidateGQLClient()
  }
}
