/**
 * Shared test utilities for E2E tests
 * Eliminates code duplication across Cursor, VS Code, and Claude Code tests
 */

/**
 * Checkpoint tracker for monitoring test progress
 * Helps debug CI failures by showing which steps completed successfully
 */
export class CheckpointTracker {
  private checkpoints: Record<string, boolean> = {}
  private testStartTime: number

  constructor(checkpointNames: string[]) {
    // Initialize all checkpoints as false
    for (const name of checkpointNames) {
      this.checkpoints[name] = false
    }
    this.testStartTime = Date.now()
  }

  /**
   * Mark a checkpoint as completed
   */
  mark(name: string): void {
    if (!(name in this.checkpoints)) {
      console.warn(`⚠️  Unknown checkpoint: ${name}`)
      return
    }
    this.checkpoints[name] = true
    console.log(`✅ CHECKPOINT: ${name}`)
  }

  /**
   * Print a summary of all checkpoints
   */
  printSummary(): void {
    console.log('')
    console.log('===============================================')
    console.log('CHECKPOINT SUMMARY')
    console.log('===============================================')
    for (const [name, passed] of Object.entries(this.checkpoints)) {
      console.log(`  ${passed ? '✅' : '❌'} ${name}`)
    }
    console.log('===============================================')
  }

  /**
   * Log a timestamped phase message
   */
  logTimestamp(phase: string, details?: Record<string, unknown>): void {
    const elapsed = Date.now() - this.testStartTime
    const elapsedStr = `${Math.floor(elapsed / 60000)}m ${Math.floor((elapsed % 60000) / 1000)}s`
    const detailsStr = details ? ` | ${JSON.stringify(details)}` : ''
    console.log(`⏱️  [${elapsedStr}] ${phase}${detailsStr}`)
  }

  /**
   * Get all checkpoint statuses
   */
  getCheckpoints(): Record<string, boolean> {
    return { ...this.checkpoints }
  }

  /**
   * Check if all checkpoints passed
   */
  allPassed(): boolean {
    return Object.values(this.checkpoints).every((passed) => passed)
  }
}
