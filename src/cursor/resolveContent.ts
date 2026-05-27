/**
 * Inline `composer.content.<sha256>` rows into `edit_file_v2` bubbles before
 * upload.
 *
 * Why this exists: since 2026-04-30 Cursor stopped inlining
 * `params.streamingContent` on `edit_file_v2` bubbles. The bubble's
 * `toolFormerData.result` carries `afterContentId` (and optionally
 * `beforeContentId`) — strings that reference separate
 * `composer.content.<sha256>` rows in `cursorDiskKV`. The backend parser
 * still reads inline content, so we resolve those references on the
 * extension side and attach the strings under a new `resolvedContent`
 * field. The legacy `streamingContent` extractor path stays intact for old
 * uploads still in S3.
 *
 * Scope: `edit_file_v2` only. Verified against a real affected user's DB:
 * post-cutoff bubbles are 100% v2; the other five file-edit tools
 * (`search_replace`, `apply_patch`, `write`, `edit_file`, `MultiEdit`) have
 * zero post-cutoff activity and still ship inline diffs.
 */

import { logger } from '../shared/logger'
import type { CursorRawRecord } from './rawProcessor'

/**
 * Cap on the UTF-8 byte size of any single resolved content row. Measured on
 * a sampled affected user's DB during the T-516 investigation: max observed
 * content ~3.2MB across 295 distinct rows. 20MB is ~6× that observed
 * ceiling — covers vendored / generated files we haven't seen yet without
 * letting a pathological one OOM the worker payload. Hardcoded constant; no
 * env knob (the value is internal capacity sizing, not a user-facing tunable).
 */
const MAX_CONTENT_BYTES = 20 * 1024 * 1024

/**
 * Cursor stores content-by-reference keys as `composer.content.<sha256>`.
 * We validate the prefix + string-ness before binding to SQLite or indexing
 * the content map: a future Cursor wire change (or an attacker-shaped
 * local DB row) could put a non-string here, and we want to drop it
 * cleanly rather than crash the worker on the `stmt.all(...)` bind step.
 *
 * Deliberately not enforcing the full `[a-f0-9]{64}` shape — a key that
 * doesn't match nothing in the DB harmlessly returns no row; a mis-typed
 * key just doesn't resolve. Strict shape enforcement gains nothing and
 * fails the test fixtures that use shorter SHAs for readability.
 */
const CONTENT_KEY_PREFIX = 'composer.content.'

function isContentKey(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(CONTENT_KEY_PREFIX)
}

function utf8ByteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/**
 * The wire-shape we attach to `bubble.toolFormerData` before upload. The
 * backend's `BubbleData` declares an inline shape that **must stay in sync
 * with this type** — drift between the two sides would cause silent data
 * loss exactly like the bug this PR is fixing. The canonical declaration
 * lives here; the backend's inline shape carries a cross-reference
 * comment pointing back. (Promoting this to `tscommon` is the eventual
 * shared-types fix tracked under T-516 P3 #16.)
 */
export type ResolvedContent = {
  after: string
  before?: string
}

type V2BubbleResult = {
  beforeContentId?: unknown
  afterContentId?: unknown
}

type V2Bubble = {
  toolFormerData?: {
    name?: string
    toolCallId?: string
    result?: string
    resolvedContent?: ResolvedContent
  }
}

type V2BubbleWithToolFormer = {
  toolFormerData: NonNullable<V2Bubble['toolFormerData']>
}

type PendingResolution = {
  record: CursorRawRecord
  toolCallId: string | undefined
  afterId: string
  beforeId: string | undefined
}

function isV2EditBubble(bubble: unknown): bubble is V2BubbleWithToolFormer {
  return (
    typeof bubble === 'object' &&
    bubble !== null &&
    (bubble as V2Bubble).toolFormerData?.name === 'edit_file_v2'
  )
}

/**
 * Parse the bubble's `result` field, which Cursor stores as a JSON string.
 * Returns `null` if missing or unparseable. Parse failures are logged at
 * debug level so a future wire-format change leaves a breadcrumb instead
 * of vanishing silently (the original incident hid for 2.5 weeks because
 * its symptoms were silent).
 */
function parseResult(
  resultStr: string | undefined,
  toolCallId: string | undefined
): V2BubbleResult | null {
  if (!resultStr) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(resultStr)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    return parsed as V2BubbleResult
  } catch (err) {
    logger.debug(
      { err, toolCallId },
      '[resolveContent] failed to parse bubble result JSON'
    )
    return null
  }
}

/**
 * For each `edit_file_v2` record whose `result` carries an
 * `afterContentId`, resolve the referenced `composer.content.<sha256>` rows
 * and attach `bubble.toolFormerData.resolvedContent = { after, before? }`.
 *
 * Records that don't qualify (non-v2 tools, legacy bubbles without an
 * `afterContentId`, oversize content, missing rows) are left untouched —
 * the backend's existing legacy `streamingContent` path runs and, when it
 * returns null on a new-format payload, the regression-detection log
 * inside `extractFromEditFileV2` fires.
 *
 * Worker errors are different: they are transient (SQLITE_BUSY, worker
 * recycle) and shipping the bubble unchanged means the cursor advances
 * past it forever. Instead, return the affected records in `failed` so
 * the caller can re-queue them via the incomplete-bubble revisit
 * mechanism — next cycle will resolve them once the worker recovers.
 *
 * Mutates the bubble in place. Never throws.
 */
export type AttachResolvedContentResult = {
  /**
   * Records whose resolution failed transiently (worker error) and should
   * be re-queued for retry next poll cycle rather than shipped without
   * `resolvedContent`. Empty on the happy path. See T-516 review Finding 1.
   */
  failed: Array<{
    sessionId: string
    recordId: string
    toolCallId: string | undefined
  }>
}

export async function attachResolvedContent(
  records: CursorRawRecord[],
  fetchComposerContent: (keys: string[]) => Promise<Record<string, string>>
): Promise<AttachResolvedContentResult> {
  if (records.length === 0) {
    return { failed: [] }
  }

  const pending: PendingResolution[] = []
  const keys = new Set<string>()

  for (const record of records) {
    if (!isV2EditBubble(record.bubble)) {
      continue
    }
    // `isV2EditBubble` already narrows `toolFormerData` to non-undefined.
    const tfd = record.bubble.toolFormerData
    const parsed = parseResult(tfd.result, tfd.toolCallId)
    const afterId = parsed?.afterContentId
    // Reject non-string or wrong-shape IDs before binding to SQLite. A
    // malformed bubble (future wire change, local DB tamper) would
    // otherwise crash the worker `stmt.all(...)` bind step.
    if (!isContentKey(afterId)) {
      continue
    }
    const rawBeforeId = parsed?.beforeContentId
    const beforeId = isContentKey(rawBeforeId) ? rawBeforeId : undefined
    pending.push({
      record,
      toolCallId: tfd.toolCallId,
      afterId,
      beforeId,
    })
    keys.add(afterId)
    if (beforeId) {
      keys.add(beforeId)
    }
  }

  if (pending.length === 0) {
    return { failed: [] }
  }

  let contentMap: Record<string, string>
  try {
    contentMap = await fetchComposerContent(Array.from(keys))
  } catch (err) {
    // Transient worker failure (SQLITE_BUSY, recycle, etc). Return the
    // affected records as `failed` so the caller re-queues them via
    // incompleteBubbles — letting the cursor advance past them now would
    // permanently lose attribution for the cycle's edits.
    logger.error(
      {
        err,
        affectedRecords: pending.length,
        affectedToolCallIds: pending
          .map((p) => p.toolCallId)
          .filter((id): id is string => typeof id === 'string'),
      },
      '[resolveContent] fetchComposerContent failed — records re-queued for retry'
    )
    return {
      failed: pending.map((p) => ({
        sessionId: p.record.metadata.sessionId,
        recordId: p.record.metadata.recordId,
        toolCallId: p.toolCallId,
      })),
    }
  }

  // Aggregate per-cycle byte budget — protects the JSON.stringify peak on
  // the upload path. Tied to ~5× the per-row cap; once exceeded, remaining
  // records ship without `resolvedContent` (backend regression log will
  // fire). See T-516 review Findings 6 + 7.
  const MAX_CYCLE_BYTES = 5 * MAX_CONTENT_BYTES
  let attachedBytes = 0
  let budgetExceededLogged = false

  for (const p of pending) {
    const after = contentMap[p.afterId]
    if (typeof after !== 'string') {
      // Row not found in cursorDiskKV — leave bubble untouched. Backend
      // will return null and the regression log will fire.
      continue
    }
    const afterBytes = utf8ByteLength(after)
    if (afterBytes > MAX_CONTENT_BYTES) {
      logger.debug(
        {
          toolCallId: p.toolCallId,
          byteSize: afterBytes,
          cap: MAX_CONTENT_BYTES,
        },
        '[resolveContent] skipping oversize after-content for edit_file_v2'
      )
      continue
    }
    if (attachedBytes + afterBytes > MAX_CYCLE_BYTES) {
      if (!budgetExceededLogged) {
        budgetExceededLogged = true
        logger.warn(
          {
            attachedBytes,
            cycleBudget: MAX_CYCLE_BYTES,
            remainingRecords:
              pending.length - pending.findIndex((x) => x === p),
          },
          '[resolveContent] cycle byte budget exceeded; remaining edit_file_v2 records ship without resolvedContent'
        )
      }
      continue
    }
    const before = p.beforeId ? contentMap[p.beforeId] : undefined
    const beforeBytes = typeof before === 'string' ? utf8ByteLength(before) : 0
    const includeBefore =
      typeof before === 'string' &&
      beforeBytes <= MAX_CONTENT_BYTES &&
      attachedBytes + afterBytes + beforeBytes <= MAX_CYCLE_BYTES
    const resolved: ResolvedContent = includeBefore
      ? { after, before: before as string }
      : { after }
    attachedBytes += afterBytes + (includeBefore ? beforeBytes : 0)
    // Mutate in place. CursorRawRecord.bubble is typed `unknown` upstream;
    // narrowing happened in `isV2EditBubble`.
    const bubble = p.record.bubble as V2Bubble
    if (bubble.toolFormerData) {
      bubble.toolFormerData.resolvedContent = resolved
    }
  }

  return { failed: [] }
}
