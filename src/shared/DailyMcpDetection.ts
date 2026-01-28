import { detectMCPServers } from '../mobbdev_src/mcp'
import { createGQLClient } from './gqlClientFactory'
import { logger } from './logger'
import { AppType, detectAppType } from './repositoryInfo'

const ONE_DAY_MS = 24 * 60 * 60 * 1000 // 24 hours in milliseconds

class DailyMcpDetection {
  private interval: NodeJS.Timeout | null = null

  start(): void {
    this.stop()

    logger.info('Running initial MCP detection')
    detectMcps().catch((err) => {
      logger.error({ err }, 'Initial MCP detection failed')
    })

    this.interval = setInterval(() => {
      logger.info('Running scheduled daily MCP detection')
      detectMcps().catch((err) => {
        logger.error({ err }, 'Scheduled daily MCP detection failed')
      })
    }, ONE_DAY_MS)

    logger.info('Started daily MCP detection timer')
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
      logger.info('Stopped daily MCP detection timer')
    }
  }
}

export const dailyMcpDetection = new DailyMcpDetection()

export async function detectMcps() {
  try {
    const gqlClient = await createGQLClient()
    const userInfo = await gqlClient.getUserInfo()
    const userEmail = userInfo?.email

    if (!userEmail) {
      logger.error('Could not retrieve user email for MCP detection')
      return
    }

    // Detect IDE type
    const appType = detectAppType()

    if (appType != AppType.VSCODE && appType != AppType.CURSOR) {
      logger.error(`MCP detection skipped: Unsupported IDE type ${appType}`)
      return
    }

    // Detect MCP servers
    const { organizationId, userName } = await gqlClient.getLastOrg(userEmail)

    if (!organizationId) {
      logger.error(
        `Detecting MCP servers for IDE: ${appType} is impossible because organization does not exist`
      )
      return
    }

    detectMCPServers({
      ideName: appType,
      userEmail,
      userName,
      organizationId: String(organizationId),
    })
  } catch (e) {
    logger.error(
      { error: e },
      'MCP detection failed, continuing with activation'
    )
  }
}
