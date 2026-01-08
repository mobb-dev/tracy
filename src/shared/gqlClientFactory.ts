import { getAuthenticatedGQLClient } from '../mobbdev_src/commands/handleMobbLogin'
import { GQLClient } from '../mobbdev_src/features/analysis/graphql'
import { getConfig } from './config'
import { logger } from './logger'

/**
 * Creates an authenticated GQL client using the extension's config.
 * Convenience wrapper that combines getConfig() + getAuthenticatedGQLClient().
 */
export async function createGQLClient(): Promise<GQLClient> {
  const config = getConfig()
  logger.info('Creating GQL client', {
    apiUrl: config.apiUrl,
    webAppUrl: config.webAppUrl,
  })
  return getAuthenticatedGQLClient({
    apiUrl: config.apiUrl,
    webAppUrl: config.webAppUrl,
  })
}
