import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { configStore } from '../mobbdev_src/utils/ConfigStoreService'
import { logger } from '../shared/logger'
import { getVSCodeUserDir } from '../shared/platformPaths'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CopilotRawRecord = {
  request: {
    requestId: string
    modelId: string
    timestamp: number
    message: { text: string }
    response: unknown[]
    result: unknown
  }
  metadata: {
    sessionId: string
    /** Workspace repo mapping for server-side per-event repo URL resolution.
     *  Each entry maps a local git root to its remote URL. */
    workspaceRepos?: { gitRoot: string; gitRepoUrl: string }[]
  }
}

export type SessionFile = {
  path: string
  size: number
}

/** In-memory state for a single JSONL session file.
 *
 * Uses two complementary indexes:
 * - kind:2 data keyed by requestId (response[], message, modelId)
 * - kind:1 patches keyed by original index (result, modelState)
 * - Appearance order links the two: Nth unique requestId = original index N
 */
export type SessionFileState = {
  sessionId: string | null
  /** requestId → latest snapshot data from kind:2 */
  requestData: Map<
    string,
    {
      response: unknown[]
      message: { text?: string }
      modelId: string
      /** modelState from kind:2 (old format has it inline, new format uses kind:1) */
      modelState?: { value?: number; completedAt?: number }
      /** result from kind:2 (old format has it inline) */
      result?: unknown
      /** When this request was first seen (for stuck request detection) */
      firstSeenAt: number
    }
  >
  /** Original index → kind:1 patch data (result, modelState) */
  indexPatches: Map<
    number,
    {
      result: unknown
      modelState: { value?: number; completedAt?: number }
    }
  >
  /** requestIds in order of first appearance (position = original index) */
  appearanceOrder: string[]
  uploadedRequestIds: Set<string>
}

type CursorValue = {
  byteOffset: number
  fileSize: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STALE_KEY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000 // 14 days
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000 // 1 day
/** On first run (no stored cursor), only process files modified within this window. */
const FIRST_RUN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
/** Upload stuck requests after this timeout — Copilot crashed or user closed mid-stream.
 *  The request may have generated code (file creates, patches) before it got stuck. */
const STUCK_REQUEST_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes

/** Copilot modelState.value lifecycle (from JSONL kind:1 patches). */
const ModelState = {
  Pending: 0,
  Completed: 1,
  Cancelled: 2,
  PlanCompleted: 3,
  Intermediate: 4,
} as const

// ---------------------------------------------------------------------------
// ConfigStore key helpers
// ---------------------------------------------------------------------------

function getCursorKey(filePath: string): string {
  const hash = createHash('sha256').update(filePath).digest('hex').slice(0, 12)
  return `copilot.session.${hash}`
}

// ---------------------------------------------------------------------------
// Workspace storage discovery
// ---------------------------------------------------------------------------

function getWorkspaceStorageBase(): string {
  return path.join(getVSCodeUserDir(), 'workspaceStorage')
}

/**
 * Discover JSONL files that have new data since last read.
 * Only scans the current window's workspace storage to ensure workspace repo
 * mapping matches the session files. Other windows handle their own sessions.
 * Falls back to scanning all workspaces if no workspace path is provided.
 * Fully async to avoid blocking the VS Code UI thread.
 */
export async function discoverActiveSessionFiles(
  workspaceStoragePath?: string
): Promise<SessionFile[]> {
  const results: { path: string; size: number; mtimeMs: number }[] = []

  // Collect chatSessions directories to scan
  const chatSessionsDirs: string[] = []

  if (workspaceStoragePath) {
    // Scoped: only this window's workspace
    const dir = path.join(workspaceStoragePath, 'chatSessions')
    chatSessionsDirs.push(dir)
  } else {
    // Fallback: scan all workspaces (degraded repo URL resolution)
    const base = getWorkspaceStorageBase()
    try {
      const workspaceDirs = await fs.readdir(base)
      for (const wsDir of workspaceDirs) {
        chatSessionsDirs.push(path.join(base, wsDir, 'chatSessions'))
      }
    } catch {
      return []
    }
  }

  for (const chatSessionsDir of chatSessionsDirs) {
    let files: string[]
    try {
      files = await fs.readdir(chatSessionsDir)
    } catch {
      continue
    }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) {
        continue
      }
      const filePath = path.join(chatSessionsDir, file)
      let stat: Awaited<ReturnType<typeof fs.stat>>
      try {
        stat = await fs.stat(filePath)
      } catch {
        continue
      }

      const stored = configStore.get(getCursorKey(filePath)) as
        | CursorValue
        | undefined
      if (stored && stat.size === stored.fileSize) {
        continue // no new data
      }

      // First run (no cursor): skip files older than 7 days to avoid
      // processing the entire history on first activation.
      if (!stored && Date.now() - stat.mtimeMs > FIRST_RUN_MAX_AGE_MS) {
        continue
      }

      results.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs })
    }
  }

  // Most recently modified first — ensures fresh sessions are processed
  // before old ones when MAX_SESSION_FILES_PER_CYCLE caps the batch.
  results.sort((a, b) => b.mtimeMs - a.mtimeMs)

  return results
}

// ---------------------------------------------------------------------------
// JSONL line processing
// ---------------------------------------------------------------------------

/**
 * Read sessionId from the first line (kind:0) of a JSONL file.
 * Used after restart when in-memory state is lost but cursor is past kind:0.
 */
export async function readSessionId(filePath: string): Promise<string | null> {
  try {
    // sessionId is near the start of kind:0 but the line can be 30KB+.
    // Read a small chunk and extract via regex instead of JSON.parse.
    const fh = await fs.open(filePath, 'r')
    try {
      const buf = Buffer.alloc(1024)
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      const chunk = buf.toString('utf-8', 0, bytesRead)
      const match = chunk.match(/"sessionId"\s*:\s*"([^"]+)"/)
      return match?.[1] ?? null
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
}

/**
 * Read new bytes from a JSONL file starting at the stored byte offset.
 * Reads the entire remaining file — Copilot JSONL files are typically <5MB.
 * Fully async to avoid blocking the VS Code UI thread.
 */
export async function readNewLines(filePath: string): Promise<{
  lines: string[]
  newByteOffset: number
  newFileSize: number
}> {
  const stored = configStore.get(getCursorKey(filePath)) as
    | CursorValue
    | undefined
  const byteOffset = stored?.byteOffset ?? 0

  const stat = await fs.stat(filePath)
  const currentSize = stat.size

  // Handle truncation: if offset is past EOF, reset to 0
  const effectiveOffset = byteOffset > currentSize ? 0 : byteOffset

  if (effectiveOffset >= currentSize) {
    return {
      lines: [],
      newByteOffset: effectiveOffset,
      newFileSize: currentSize,
    }
  }

  const MAX_READ_BYTES = 20 * 1024 * 1024 // 20 MB
  const bytesToRead = currentSize - effectiveOffset
  if (bytesToRead > MAX_READ_BYTES) {
    logger.warn(
      { filePath, bytesToRead, maxBytes: MAX_READ_BYTES },
      'JSONL file delta exceeds max read size — reading partial data'
    )
  }
  const cappedBytes = Math.min(bytesToRead, MAX_READ_BYTES)

  const fh = await fs.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(cappedBytes)
    await fh.read(buffer, 0, cappedBytes, effectiveOffset)
    const text = buffer.toString('utf-8')
    // If capped, drop the last partial line (may be truncated mid-JSON)
    const allLines = text.split('\n')
    const lines =
      cappedBytes < bytesToRead && !text.endsWith('\n')
        ? allLines.slice(0, -1).filter((l) => l.trim().length > 0)
        : allLines.filter((l) => l.trim().length > 0)
    const newByteOffset =
      cappedBytes < bytesToRead
        ? effectiveOffset + Buffer.byteLength(`${lines.join('\n')}\n`, 'utf-8')
        : currentSize
    return { lines, newByteOffset, newFileSize: currentSize }
  } finally {
    await fh.close()
  }
}

/**
 * Process JSONL lines into in-memory state and return completed requests.
 * Pure in-memory — no file I/O.
 */

type CompletionStatus =
  | { kind: 'completed'; completedAt: number }
  | { kind: 'stuck'; completedAt: undefined }
  | { kind: 'cancelled' }
  | { kind: 'pending' }

/** Determine whether a request is ready for upload. */
function getCompletionStatus(
  patch: SessionFileState['indexPatches'] extends Map<number, infer V>
    ? V | undefined
    : never,
  data: {
    modelState?: { value?: number; completedAt?: number }
    firstSeenAt: number
    response: unknown[]
  }
): CompletionStatus {
  const patchMs = patch?.modelState
  const dataMs = data.modelState

  const isCompleted = (v: number | undefined) =>
    v === ModelState.Completed || v === ModelState.PlanCompleted

  // Prefer kind:1 patch, fall back to kind:2 inline
  const completedMs =
    isCompleted(patchMs?.value) && patchMs?.completedAt
      ? patchMs
      : isCompleted(dataMs?.value) && dataMs?.completedAt
        ? dataMs
        : null

  if (completedMs) {
    return { kind: 'completed', completedAt: completedMs.completedAt! }
  }

  if (
    patchMs?.value === ModelState.Cancelled ||
    dataMs?.value === ModelState.Cancelled
  ) {
    return { kind: 'cancelled' }
  }

  // Stuck: has response data but never completed or cancelled after timeout
  if (
    data.response.length > 0 &&
    Date.now() - data.firstSeenAt >= STUCK_REQUEST_TIMEOUT_MS
  ) {
    return { kind: 'stuck', completedAt: undefined }
  }

  return { kind: 'pending' }
}

/**
 * Process JSONL lines into in-memory state and return completed requests.
 *
 * Uses two complementary indexes to avoid the kind:1/kind:2 index mismatch:
 * - kind:2 data keyed by requestId (response[], message, modelId)
 * - kind:1 patches keyed by original index (result, modelState)
 * - Appearance order links them: Nth unique requestId = original index N
 */
export function processLines(
  lines: string[],
  state: SessionFileState,
  maxRecords?: number
): { records: CopilotRawRecord[]; emittedIds: string[] } {
  for (const line of lines) {
    let obj: { kind?: number; k?: (string | number)[]; v?: unknown }
    try {
      obj = JSON.parse(line) as typeof obj
    } catch {
      continue
    }

    const { kind } = obj

    if (kind === 0) {
      const v = obj.v as
        | { sessionId?: string; requests?: unknown[] }
        | undefined
      if (v?.sessionId) {
        state.sessionId = v.sessionId
      }
      // Seed from kind:0 requests (if user typed before file was created)
      if (Array.isArray(v?.requests)) {
        for (const req of v.requests) {
          const r = req as Record<string, unknown> | undefined
          const rid = r?.['requestId'] as string | undefined
          if (!rid || !r) {
            continue
          }
          trackRequestData(state, rid, r)
        }
      }
    } else if (kind === 1) {
      const { k } = obj
      if (!Array.isArray(k) || k.length < 3 || k[0] !== 'requests') {
        continue
      }
      const originalIdx = Number(k[1])
      if (Number.isNaN(originalIdx)) {
        continue
      }
      const field = k[2] as string

      // Ensure patch slot exists
      if (!state.indexPatches.has(originalIdx)) {
        state.indexPatches.set(originalIdx, { result: null, modelState: {} })
      }
      const patch = state.indexPatches.get(originalIdx)!

      if (field === 'result') {
        patch.result = obj.v
      } else if (field === 'modelState') {
        patch.modelState = obj.v as { value?: number; completedAt?: number }
      }
    } else if (kind === 2) {
      const { v } = obj
      if (!Array.isArray(v)) {
        continue
      }
      for (const req of v) {
        const r = req as Record<string, unknown> | undefined
        if (!r || typeof r !== 'object') {
          continue
        }
        const rid = r['requestId'] as string | undefined
        if (!rid) {
          continue
        }
        trackRequestData(state, rid, r)
      }
    }
  }

  // Assemble completed requests by joining the two indexes via appearance order.
  // emittedIds tracks which requestIds were included — caller must commit them
  // to uploadedRequestIds only after successful upload.
  const records: CopilotRawRecord[] = []
  const emittedIds: string[] = []
  for (let i = 0; i < state.appearanceOrder.length; i++) {
    if (maxRecords != null && records.length >= maxRecords) {
      break
    }

    const requestId = state.appearanceOrder[i]
    if (state.uploadedRequestIds.has(requestId)) {
      continue
    }

    const data = state.requestData.get(requestId)
    if (!data || data.response.length === 0) {
      continue
    }

    const patch = state.indexPatches.get(i)
    const status = getCompletionStatus(patch, data)

    if (status.kind === 'cancelled' || status.kind === 'pending') {
      continue
    }

    if (status.kind === 'stuck') {
      logger.info(
        `Uploading stuck request ${requestId.slice(0, 20)} (${Math.round((Date.now() - data.firstSeenAt) / 60000)}min old)`
      )
    }

    records.push({
      request: {
        requestId,
        modelId: data.modelId,
        timestamp: status.completedAt ?? Date.now(),
        message: { text: data.message.text ?? '' },
        response: data.response,
        result: patch?.result ?? data.result ?? null,
      },
      metadata: {
        sessionId: state.sessionId ?? '',
      },
    })
    emittedIds.push(requestId)
  }

  return { records, emittedIds }
}

/** Track/update request data from kind:0 or kind:2 snapshots, keyed by requestId. */
function trackRequestData(
  state: SessionFileState,
  requestId: string,
  req: Record<string, unknown>
): void {
  // Track appearance order (first seen = original index 0, etc.)
  // Use requestData.has() for O(1) lookup instead of O(n) Array.includes()
  if (!state.requestData.has(requestId)) {
    state.appearanceOrder.push(requestId)
  }

  // Update snapshot data (always use latest kind:2 data)
  const { response } = req as { response?: unknown }
  const existing = state.requestData.get(requestId)
  const newMs = req['modelState'] as
    | { value?: number; completedAt?: number }
    | undefined
  state.requestData.set(requestId, {
    response:
      Array.isArray(response) && response.length > 0
        ? (response as unknown[])
        : (existing?.response ?? []),
    message: (req['message'] as { text?: string }) ?? existing?.message ?? {},
    modelId: (req['modelId'] as string) ?? existing?.modelId ?? '',
    // Preserve modelState/result from kind:2 (old format) — only update if present
    modelState: newMs?.completedAt ? newMs : existing?.modelState,
    result: req['result'] ?? existing?.result,
    firstSeenAt: existing?.firstSeenAt ?? Date.now(),
  })
}

// ---------------------------------------------------------------------------
// Cursor management
// ---------------------------------------------------------------------------

export function createEmptyState(): SessionFileState {
  return {
    sessionId: null,
    requestData: new Map(),
    indexPatches: new Map(),
    appearanceOrder: [],
    uploadedRequestIds: new Set(),
  }
}

/**
 * Advance the byte-offset cursor after successful upload.
 */
export function advanceCursor(
  filePath: string,
  newByteOffset: number,
  newFileSize: number
): void {
  const cursorKey = getCursorKey(filePath)
  const value: CursorValue = {
    byteOffset: newByteOffset,
    fileSize: newFileSize,
    updatedAt: Date.now(),
  }
  configStore.set(cursorKey, value)
}

/**
 * Remove stale cursor keys older than 14 days.
 * Runs at most once per day.
 */
export function cleanupStaleCursors(): void {
  const lastCleanup = configStore.get('copilot.lastCleanupAt') as
    | number
    | undefined
  if (lastCleanup && Date.now() - lastCleanup < CLEANUP_INTERVAL_MS) {
    return
  }

  const now = Date.now()
  const allConfig = configStore.all as Record<string, unknown>
  const copilotSection = allConfig['copilot'] as
    | Record<string, unknown>
    | undefined
  if (!copilotSection) {
    return
  }

  const sessionCursors = copilotSection['session'] as
    | Record<string, unknown>
    | undefined
  if (!sessionCursors || typeof sessionCursors !== 'object') {
    return
  }

  let deletedCount = 0
  for (const key of Object.keys(sessionCursors)) {
    const val = sessionCursors[key] as CursorValue | undefined
    if (val?.updatedAt && now - val.updatedAt > STALE_KEY_MAX_AGE_MS) {
      configStore.delete(`copilot.session.${key}`)
      deletedCount++
    }
  }

  configStore.set('copilot.lastCleanupAt', now)
  if (deletedCount > 0) {
    logger.info(`Cleaned up ${deletedCount} stale copilot session cursor keys`)
  }
}
