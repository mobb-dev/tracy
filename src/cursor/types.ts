/**
 * Shared types for the cursor DB module.
 *
 * Defined in their own file so both `db.ts` (main thread) and `dbWorker.ts`
 * (worker thread) can import the same definitions. The worker boundary uses
 * untyped `postMessage`, so without a single source of truth a missing field
 * would only surface as a runtime parsing failure.
 */

/** Represents a row from the `cursorDiskKV` table in Cursor's database. */
export type DBRow = {
  rowid?: number
  key: string
  value?: string
}

/** Per-session prefetch request sent to the worker. */
export type SessionRequest = {
  composerId: string
  /** SQLite rowid cursor — only return bubbles strictly newer than this. */
  afterRowId?: number
  /** Exact keys of previously-incomplete bubbles to re-check. */
  incompleteBubbleKeys?: string[]
  /**
   * Exact bubble keys already discovered by `getRecentBubbleKeys`. When
   * present, the worker uses an exact-key `IN (...)` lookup instead of a
   * `LIKE 'bubbleId:<id>:%'` scan — orders of magnitude faster on multi-GB
   * databases where the LIKE scan blows past the worker timeout (T-445).
   */
  discoveredKeys?: string[]
}

/** Per-session prefetch result returned by the worker. */
export type SessionResult = {
  composerId: string
  bubbles: DBRow[]
  composerDataValue: string | undefined
  /** Re-fetched incomplete bubbles (by exact key). */
  revisitedBubbles: DBRow[]
}
