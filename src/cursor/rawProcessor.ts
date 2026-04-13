import { configStore } from '../mobbdev_src/utils/ConfigStoreService'
import { logger } from '../shared/logger'
import type { DBRow } from './types'

/**
 * Shape of raw data sent to the server.
 * MUST match CursorRawData in tscommon/backend/src/utils/tracyParsers/cursorParser.ts:55-62.
 */
export type CursorRawRecord = {
  bubble: unknown
  metadata: {
    recordId: string
    sessionId: string
    model: string
    /** SQLite rowid — used for cursor advancement (not sent to server). */
    rowid?: number
    /** Number of bubbles fetched for this session — used to detect LIMIT-capped batches. */
    bubblesFetched?: number
  }
}

type IncompleteBubble = {
  key: string
  firstSeenAt: number
}

type CursorValue = {
  recordId: string
  timestamp: string
  updatedAt: number
  /** SQLite rowid of the last uploaded bubble — used for fast rowid-based queries. */
  lastRowId?: number
  /** True if the last fetch hit SESSION_BUBBLES_LIMIT — may have more data. */
  pending?: boolean
  /** Bubbles skipped because their tool status was non-terminal. */
  incompleteBubbles?: IncompleteBubble[]
}

/** Single source of truth — also passed to dbWorker via workerData. */
export const SESSION_BUBBLES_LIMIT = 50

const STALE_KEY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000 // 14 days
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000 // 1 day
const STUCK_TOOL_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes

const TERMINAL_TOOL_STATUSES = new Set([
  'completed',
  'rejected',
  'failed',
  'cancelled',
])

function getCursorKey(composerId: string): string {
  return `cursor.uploadCursor.${composerId}`
}

/**
 * Extract the bubble UUID from a SQLite key.
 * Key format: `bubbleId:{composerId}:{bubbleId}` → returns `{bubbleId}`
 */
function extractBubbleId(key: string): string {
  const lastColon = key.lastIndexOf(':')
  return lastColon >= 0 ? key.substring(lastColon + 1) : key
}

/**
 * Extract the composerId from a `bubbleId:<composerId>:<bubbleId>` key.
 * Returns `undefined` for keys that don't match the expected shape so
 * callers can decide whether to skip / log / fall back.
 *
 * Single source of truth for the key format — used by both
 * `discoverActiveSessions` and `groupRecentKeysBySession`.
 */
export function extractComposerIdFromKey(key: string): string | undefined {
  const parts = key.split(':')
  if (parts.length >= 3 && parts[1]) {
    return parts[1]
  }
  return undefined
}

/** Throttle for `unexpectedKeyFormat` warnings — log at most once per process. */
let didWarnUnexpectedKeyFormat = false

/**
 * Group recent bubble keys by composerId so the worker can use a fast
 * `WHERE key IN (...)` lookup instead of a `LIKE` scan per session.
 *
 * Logs a one-time warning if any keys don't match the expected
 * `bubbleId:<composerId>:<bubbleId>` shape — silently dropping malformed
 * keys would mask a Cursor schema change that disables our fast path.
 */
export function groupRecentKeysBySession(
  recentBubbles: DBRow[]
): Map<string, string[]> {
  const keysBySession = new Map<string, string[]>()
  let unexpectedSample: string | undefined
  for (const row of recentBubbles) {
    const composerId = extractComposerIdFromKey(row.key)
    if (composerId === undefined) {
      if (unexpectedSample === undefined) {
        unexpectedSample = row.key
      }
      continue
    }
    let list = keysBySession.get(composerId)
    if (list === undefined) {
      list = []
      keysBySession.set(composerId, list)
    }
    list.push(row.key)
  }
  if (unexpectedSample !== undefined && !didWarnUnexpectedKeyFormat) {
    didWarnUnexpectedKeyFormat = true
    logger.warn(
      { sampleKey: unexpectedSample },
      '[rawProcessor] Unexpected bubble-key format — fast-path IN(...) query may degrade to LIKE scan. Verify Cursor key schema.'
    )
  }
  return keysBySession
}

/** Test-only: reset the one-shot warn flag between test cases. */
export function _resetKeyFormatWarnForTests(): void {
  didWarnUnexpectedKeyFormat = false
}

/**
 * Extract unique composerIds from recent bubble keys, supplemented by
 * persisted cursors from configStore. This ensures sessions that go idle
 * (falling outside the recent window) are still re-fetched if they have
 * unfetched bubbles from a previous LIMIT-capped query.
 * Key format: `bubbleId:{composerId}:{bubbleId}`
 */
export function discoverActiveSessions(recentBubbles: DBRow[]): string[] {
  const sessionIds = new Set<string>()

  // Sessions with recent activity
  for (const row of recentBubbles) {
    const composerId = extractComposerIdFromKey(row.key)
    if (composerId !== undefined) {
      sessionIds.add(composerId)
    }
  }

  // Sessions marked as pending (hit LIMIT on last fetch — may have more data)
  for (const composerId of getPendingSessionIds()) {
    sessionIds.add(composerId)
  }

  return Array.from(sessionIds)
}

/**
 * Read composerIds from persisted upload cursors that are marked as pending
 * (hit SESSION_BUBBLES_LIMIT on last fetch — may have unfetched data).
 * Sessions that returned fewer than the limit are fully uploaded and excluded.
 */
function getPendingSessionIds(): string[] {
  const allConfig = configStore.all as Record<string, unknown>
  const cursorSection = allConfig['cursor'] as
    | Record<string, unknown>
    | undefined
  if (!cursorSection) {
    return []
  }

  const uploadCursors = cursorSection['uploadCursor'] as
    | Record<string, unknown>
    | undefined
  if (!uploadCursors || typeof uploadCursors !== 'object') {
    return []
  }

  return Object.keys(uploadCursors).filter((key) => {
    const val = uploadCursors[key] as CursorValue | undefined
    return val?.pending === true
  })
}

export type PrepareResult = {
  records: CursorRawRecord[]
  /** Newly-incomplete bubbles (non-terminal tools skipped in this batch). */
  newIncomplete: IncompleteBubble[]
  /** Highest rowid seen (uploaded or skipped) — cursor should advance past this. */
  maxRowId?: number
}

export type RevisitResult = {
  records: CursorRawRecord[]
  /** Bubbles that are still incomplete after revisiting. */
  stillIncomplete: IncompleteBubble[]
}

/**
 * Prepare raw records for upload from a session's new bubbles.
 *
 * Uses a configStore cursor to track the last uploaded record per session.
 * Walks forward from the cursor, emitting ready records. Non-terminal tool
 * bubbles are skipped (added to newIncomplete) so they don't block
 * uploading of subsequent completed bubbles.
 */
export function prepareSessionForUpload(
  bubbles: DBRow[],
  composerId: string,
  composerDataValue: string | undefined
): PrepareResult {
  const model = resolveModel(composerDataValue)

  // Load cursor to find where we left off
  const cursorKey = getCursorKey(composerId)
  const cursor = configStore.get(cursorKey) as CursorValue | undefined

  let startIndex = 0
  if (cursor) {
    const cursorIdx = bubbles.findIndex(
      (row) => extractBubbleId(row.key) === cursor.recordId
    )
    if (cursorIdx >= 0) {
      startIndex = cursorIdx + 1
    }
  }

  const records: CursorRawRecord[] = []
  const newIncomplete: IncompleteBubble[] = []
  const now = Date.now()
  let maxRowId: number | undefined

  for (let i = startIndex; i < bubbles.length; i++) {
    const row = bubbles[i]

    // Track highest rowid seen (uploaded or skipped)
    if (row.rowid != null && (maxRowId == null || row.rowid > maxRowId)) {
      maxRowId = row.rowid
    }

    if (!row.value) {
      continue
    }

    let bubble: { createdAt?: string; toolFormerData?: { status?: string } }
    try {
      bubble = JSON.parse(row.value) as typeof bubble
    } catch {
      continue
    }

    const toolStatus = bubble.toolFormerData?.status
    if (toolStatus && !TERMINAL_TOOL_STATUSES.has(toolStatus)) {
      logger.info(
        `Skipping incomplete bubble ${extractBubbleId(row.key)} (status: ${toolStatus})`
      )
      newIncomplete.push({ key: row.key, firstSeenAt: now })
      continue
    }

    records.push({
      bubble,
      metadata: {
        recordId: extractBubbleId(row.key),
        sessionId: composerId,
        model,
        rowid: row.rowid,
        bubblesFetched: bubbles.length,
      },
    })
  }

  return { records, newIncomplete, maxRowId }
}

/**
 * Re-check previously-incomplete bubbles (fetched by exact key).
 * Returns records ready to upload and bubbles still incomplete.
 */
export function revisitIncompleteBubbles(
  revisitedRows: DBRow[],
  composerId: string,
  composerDataValue: string | undefined
): RevisitResult {
  const model = resolveModel(composerDataValue)
  const cursorKey = getCursorKey(composerId)
  const cursor = configStore.get(cursorKey) as CursorValue | undefined
  const prevIncomplete = cursor?.incompleteBubbles ?? []
  const prevMap = new Map(prevIncomplete.map((b) => [b.key, b.firstSeenAt]))

  const records: CursorRawRecord[] = []
  const stillIncomplete: IncompleteBubble[] = []
  const now = Date.now()

  for (const row of revisitedRows) {
    if (!row.value) {
      continue
    }
    let bubble: { createdAt?: string; toolFormerData?: { status?: string } }
    try {
      bubble = JSON.parse(row.value) as typeof bubble
    } catch {
      continue
    }

    const toolStatus = bubble.toolFormerData?.status
    const firstSeenAt = prevMap.get(row.key) ?? now
    const isTerminal = !toolStatus || TERMINAL_TOOL_STATUSES.has(toolStatus)
    const isStuck = now - firstSeenAt >= STUCK_TOOL_TIMEOUT_MS

    const recordId = extractBubbleId(row.key)
    if (isTerminal || isStuck) {
      const waitSec = Math.round((now - firstSeenAt) / 1000)
      logger.info(
        `Revisited bubble ${recordId} → uploading (${isStuck ? 'stuck >30min' : toolStatus}, waited ${waitSec}s)`
      )
      records.push({
        bubble,
        metadata: {
          recordId,
          sessionId: composerId,
          model,
          rowid: row.rowid,
          bubblesFetched: 0,
        },
      })
    } else {
      stillIncomplete.push({ key: row.key, firstSeenAt })
    }
  }

  return { records, stillIncomplete }
}

function resolveModel(composerDataValue: string | undefined): string {
  if (!composerDataValue) {
    return ''
  }
  try {
    const composerData = JSON.parse(composerDataValue) as {
      modelConfig?: { modelName?: string }
    }
    return composerData.modelConfig?.modelName ?? ''
  } catch {
    return ''
  }
}

/**
 * Get the last-seen rowid for a session (used to scope DB queries).
 * Returns undefined if no cursor exists or cursor predates rowid tracking
 * (backward compat: falls back to unfiltered query).
 */
export function getCursorRowId(composerId: string): number | undefined {
  const cursorKey = getCursorKey(composerId)
  const cursor = configStore.get(cursorKey) as CursorValue | undefined
  return cursor?.lastRowId
}

/**
 * Get the incomplete bubble keys for a session (need to be re-fetched
 * from DB to check if they've completed).
 */
export function getIncompleteBubbleKeys(composerId: string): string[] {
  const cursorKey = getCursorKey(composerId)
  const cursor = configStore.get(cursorKey) as CursorValue | undefined
  return (cursor?.incompleteBubbles ?? []).map((b) => b.key)
}

export type AdvanceCursorOptions = {
  recordId: string
  timestamp: string
  lastRowId?: number
  pending?: boolean
  incompleteBubbles?: IncompleteBubble[]
}

/**
 * Advance the upload cursor for a session after successful upload.
 */
export function advanceCursor(
  composerId: string,
  opts: AdvanceCursorOptions
): void {
  const cursorKey = getCursorKey(composerId)
  const value: CursorValue = {
    recordId: opts.recordId,
    timestamp: opts.timestamp,
    updatedAt: Date.now(),
    lastRowId: opts.lastRowId,
    pending: opts.pending,
    incompleteBubbles:
      opts.incompleteBubbles && opts.incompleteBubbles.length > 0
        ? opts.incompleteBubbles
        : undefined,
  }
  configStore.set(cursorKey, value)
}

/**
 * Update the incomplete bubbles list and optionally advance lastRowId
 * on an existing cursor (without changing recordId/timestamp).
 * Also creates a minimal cursor if none exists (handles brand-new sessions
 * with only incomplete bubbles).
 */
export function updateIncompleteBubbles(
  composerId: string,
  incompleteBubbles: IncompleteBubble[],
  maxRowId?: number
): void {
  const cursorKey = getCursorKey(composerId)
  const cursor = configStore.get(cursorKey) as CursorValue | undefined
  if (!cursor) {
    // Brand-new session with only incomplete bubbles — create minimal cursor
    // so the incomplete list is persisted and revisited on next poll.
    if (incompleteBubbles.length > 0) {
      configStore.set(cursorKey, {
        recordId: '',
        timestamp: '',
        updatedAt: Date.now(),
        lastRowId: maxRowId,
        incompleteBubbles,
      })
    }
    return
  }
  configStore.set(cursorKey, {
    ...cursor,
    updatedAt: Date.now(),
    lastRowId:
      maxRowId != null &&
      (cursor.lastRowId == null || maxRowId > cursor.lastRowId)
        ? maxRowId
        : cursor.lastRowId,
    incompleteBubbles:
      incompleteBubbles.length > 0 ? incompleteBubbles : undefined,
  })
}

/**
 * Remove stale cursor keys older than 14 days.
 * Runs at most once per day (same pattern as Claude Code's cleanupStaleKeys).
 */
export function cleanupStaleCursors(): void {
  const lastCleanup = configStore.get('cursor.lastCleanupAt') as
    | number
    | undefined
  if (lastCleanup && Date.now() - lastCleanup < CLEANUP_INTERVAL_MS) {
    return
  }

  const now = Date.now()
  const allConfig = configStore.all as Record<string, unknown>
  const cursorSection = allConfig['cursor'] as
    | Record<string, unknown>
    | undefined
  if (!cursorSection) {
    return
  }

  const uploadCursors = cursorSection['uploadCursor'] as
    | Record<string, unknown>
    | undefined
  if (!uploadCursors || typeof uploadCursors !== 'object') {
    return
  }

  let deletedCount = 0
  for (const key of Object.keys(uploadCursors)) {
    const val = uploadCursors[key] as CursorValue | undefined
    if (val?.updatedAt && now - val.updatedAt > STALE_KEY_MAX_AGE_MS) {
      configStore.delete(`cursor.uploadCursor.${key}`)
      deletedCount++
    }
  }

  configStore.set('cursor.lastCleanupAt', now)
  if (deletedCount > 0) {
    logger.info(`Cleaned up ${deletedCount} stale cursor keys`)
  }
}
