import { logger } from './logger'
import { detectMcps } from './uploader'

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
