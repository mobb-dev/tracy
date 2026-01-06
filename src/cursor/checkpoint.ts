/**
 * WAL checkpoint module using Node.js built-in sqlite (node:sqlite).
 *
 * Uses Node 22+ built-in SQLite to checkpoint the WAL file. This is
 * cross-platform and doesn't require external binaries or native bindings.
 */

import { DatabaseSync } from 'node:sqlite'

import { logger } from '../shared/logger'

/**
 * Attempt to checkpoint the WAL file using Node.js built-in sqlite.
 *
 * Uses PASSIVE mode which checkpoints as many frames as possible without
 * waiting for readers or blocking writers.
 *
 * If checkpoint fails (e.g., database locked by Cursor), logs a warning
 * and returns. The caller will proceed with potentially stale data.
 *
 * @param dbPath - Absolute path to the SQLite database file
 */
export function checkpoint(dbPath: string): void {
  let db: DatabaseSync | undefined
  try {
    // Open database - node:sqlite can open even while Cursor has it open
    db = new DatabaseSync(dbPath)
    // PASSIVE mode won't block Cursor's operations
    db.exec('PRAGMA wal_checkpoint(PASSIVE)')
    logger.debug('[checkpoint] WAL checkpoint completed')
  } catch (err) {
    // Expected when Cursor holds the lock - we'll read potentially stale data
    // and catch up on the next poll cycle
    logger.warn(
      { err },
      '[checkpoint] WAL checkpoint failed, data may be stale'
    )
  } finally {
    db?.close()
  }
}
