import * as path from 'node:path'

import { diffLines } from 'diff'

import { AiBlameInferenceType } from '../mobbdev_src/features/analysis/scm/generates/client_generates'
import { logger } from '../shared/logger'
import { DBRow, getBubblesByKeys, releaseConnection } from './db'

// Track uploaded inferences by toolCallId
// toolCallId exists for all completed tool calls (both accepted and rejected)
const uploadedToolCallIds = new Set<string>()
const MAX_UPLOADED_IDS = 10_000

export type BubbleData = {
  type: number // 1 for user prompt, 2 for everything else
  text?: string
  createdAt: string
  toolFormerData?: {
    name: string
    status: string
    toolCallId: string
    params: string
    result: string
    rawArgs: string
    userDecision: string
    additionalData?: {
      codeblockId: string
    }
  }
  tokenCount: {
    inputTokens: number
    outputTokens: number
  }
  codeBlocks?: Array<{
    codeBlockIdx: number
    content: string
    languageId: string
    uri: {
      path: string
      scheme: string
    }
  }>
  attachedFileCodeChunksMetadataOnly?: Array<{
    relativeWorkspacePath: string
    startLineNumber: number
  }>
  thinking?: {
    text?: string
  }
}

export type ComposerData = {
  fullConversationHeadersOnly?: Array<{
    bubbleId: string
  }>
  modelConfig?: {
    modelName: string
    maxModel: boolean
  }
}

export type ProcessedChange = {
  additions: string
  conversation: BubbleData[]
  createdAt: Date
  model: string
  type: AiBlameInferenceType
  composerId?: string
  /** Absolute path to the edited file, used for per-file repository resolution. */
  filePath?: string
}

export type ProcessBubblesResult = {
  changes: ProcessedChange[]
  latestTimestamp: string | null
  hasMore: boolean
}

export function resetProcessedBubbles() {
  uploadedToolCallIds.clear()
}

/**
 * Extract the absolute file path from a bubble's tool call data.
 *
 * Cursor stores the file path in different fields depending on the tool:
 *  - edit_file (legacy): rawArgs.file_path
 *  - edit_file_v2:       params.relativeWorkspacePath (often absolute despite the name)
 *  - read_file_v2:       rawArgs.path  OR  params.targetFile
 *  - glob_file_search:   rawArgs.targetDirectory (directory, not file)
 *
 * Strategy (ordered by reliability):
 * 1. Parse rawArgs JSON → file_path | path | targetFile
 * 2. Parse params JSON  → relativeWorkspacePath | targetFile
 * 3. Fall back to codeBlocks[0].uri.path
 */
export function extractFilePath(bubbleData: BubbleData): string | undefined {
  const toolName = bubbleData.toolFormerData?.name
  const rawArgs = bubbleData.toolFormerData?.rawArgs
  const params = bubbleData.toolFormerData?.params

  // 1. Try rawArgs (multiple possible field names)
  if (rawArgs) {
    try {
      const parsed = JSON.parse(rawArgs) as Record<string, unknown>
      const candidate =
        (parsed.file_path as string) ||
        (parsed.path as string) ||
        (parsed.targetFile as string)
      if (candidate && path.isAbsolute(candidate)) {
        logger.debug(
          { toolName, filePath: candidate, source: 'rawArgs' },
          'extractFilePath: resolved from rawArgs'
        )
        return candidate
      }
    } catch {
      // rawArgs may not be valid JSON for some tool types
    }
  }

  // 2. Try params (edit_file_v2 stores path in relativeWorkspacePath)
  if (params) {
    try {
      const parsed = JSON.parse(params) as Record<string, unknown>
      const candidate =
        (parsed.relativeWorkspacePath as string) ||
        (parsed.targetFile as string)
      if (candidate && path.isAbsolute(candidate)) {
        logger.debug(
          { toolName, filePath: candidate, source: 'params' },
          'extractFilePath: resolved from params'
        )
        return candidate
      }
    } catch {
      // params may not be valid JSON
    }
  }

  // 3. Fall back to codeBlocks
  const codeBlockPath = bubbleData.codeBlocks?.[0]?.uri?.path
  if (codeBlockPath && path.isAbsolute(codeBlockPath)) {
    logger.debug(
      { toolName, filePath: codeBlockPath, source: 'codeBlocks' },
      'extractFilePath: resolved from codeBlocks fallback'
    )
    return codeBlockPath
  }

  logger.debug(
    {
      toolName,
      hasRawArgs: !!rawArgs,
      hasParams: !!params,
      hasCodeBlocks: !!bubbleData.codeBlocks?.length,
    },
    'extractFilePath: no file path found'
  )
  return undefined
}

function trackToolCallId(id: string): void {
  // Evict oldest entries when set grows too large to prevent unbounded memory
  if (uploadedToolCallIds.size >= MAX_UPLOADED_IDS) {
    const iter = uploadedToolCallIds.values()
    // Delete the oldest 20% to avoid frequent evictions
    const toDelete = Math.floor(MAX_UPLOADED_IDS * 0.2)
    for (let i = 0; i < toDelete; i++) {
      const oldest = iter.next()
      if (oldest.done) {
        break
      }
      uploadedToolCallIds.delete(oldest.value)
    }
  }
  uploadedToolCallIds.add(id)
}

// ── Types for prefetch-then-process pattern ──────────────────────────

type BubbleCandidate = {
  row: DBRow
  bubbleData: BubbleData
  composerId: string
  toolCallId: string
}

/**
 * Pre-fetched data maps. All DB reads are batched upfront so the connection
 * can be released before CPU-heavy processing begins.
 */
type PrefetchedData = {
  composers: Map<string, ComposerData | null>
  conversations: Map<string, DBRow>
  content: Map<string, string>
}

type EditFileV2Result = {
  beforeContentId: string
  afterContentId: string
}

type ToolResult = {
  diff?: {
    chunks?: {
      diffString?: string
    }[]
  }
}

// ── Phase 1: Filter rows into candidates ─────────────────────────────

type FilterResult = {
  candidates: BubbleCandidate[]
  latestTimestamp: string | null
  hasMore: boolean
}

function filterRows(
  rows: DBRow[],
  startupTimestamp: Date,
  batchLimit: number
): FilterResult {
  const candidates: BubbleCandidate[] = []
  let latestTimestamp: string | null = null
  let watermarkFrozen = false

  for (const row of rows) {
    if (!row.value) {
      continue
    }

    try {
      const bubbleData = JSON.parse(row.value) as unknown as BubbleData
      const toolCallId = bubbleData.toolFormerData?.toolCallId
      const status = bubbleData.toolFormerData?.status
      const createdAt = new Date(bubbleData.createdAt)

      // Watermark logic: only advance for completed rows before any non-completed row
      if (status !== 'completed') {
        watermarkFrozen = true
      } else if (
        !watermarkFrozen &&
        (!latestTimestamp || bubbleData.createdAt > latestTimestamp)
      ) {
        latestTimestamp = bubbleData.createdAt
      }

      if (!toolCallId || status !== 'completed') {
        continue
      }

      if (uploadedToolCallIds.has(toolCallId)) {
        continue
      }

      if (createdAt < startupTimestamp) {
        trackToolCallId(toolCallId)
        continue
      }

      if (candidates.length >= batchLimit) {
        return { candidates, latestTimestamp, hasMore: true }
      }

      const composerId = row.key.split(':')[1]
      candidates.push({ row, bubbleData, composerId, toolCallId })
    } catch {
      // Skip unparseable rows
    }
  }

  return { candidates, latestTimestamp, hasMore: false }
}

// ── Phase 2: Batch-prefetch all needed data ──────────────────────────

async function prefetchAllData(
  candidates: BubbleCandidate[]
): Promise<PrefetchedData> {
  // 1. Collect unique composerIds and batch-fetch composer data
  const composerIds = new Set<string>()
  for (const c of candidates) {
    composerIds.add(c.composerId)
  }

  const composerKeys = [...composerIds].map((id) => `composerData:${id}`)
  const composerRows = await getBubblesByKeys(composerKeys)

  const composers = new Map<string, ComposerData | null>()
  for (const row of composerRows) {
    const id = row.key.replace('composerData:', '')
    try {
      composers.set(id, JSON.parse(row.value!) as unknown as ComposerData)
    } catch {
      composers.set(id, null)
    }
  }
  // Mark missing composers as null
  for (const id of composerIds) {
    if (!composers.has(id)) {
      composers.set(id, null)
    }
  }

  // 2. From composer data, collect all conversation bubble keys
  const conversationKeys: string[] = []
  for (const c of candidates) {
    const composer = composers.get(c.composerId)
    if (!composer?.fullConversationHeadersOnly) {
      continue
    }
    for (const header of composer.fullConversationHeadersOnly) {
      conversationKeys.push(`bubbleId:${c.composerId}:${header.bubbleId}`)
    }
  }

  const conversationRows = await getBubblesByKeys([
    ...new Set(conversationKeys),
  ])
  const conversations = new Map<string, DBRow>()
  for (const row of conversationRows) {
    conversations.set(row.key, row)
  }

  // 3. For edit_file_v2 bubbles, collect content IDs and batch-fetch
  const contentKeys: string[] = []
  for (const c of candidates) {
    if (c.bubbleData.toolFormerData?.name !== 'edit_file_v2') {
      continue
    }
    try {
      const result = JSON.parse(
        c.bubbleData.toolFormerData.result
      ) as EditFileV2Result
      if (result.beforeContentId) {
        contentKeys.push(result.beforeContentId)
      }
      if (result.afterContentId) {
        contentKeys.push(result.afterContentId)
      }
    } catch {
      // Skip unparseable results
    }
  }

  const content = new Map<string, string>()
  if (contentKeys.length > 0) {
    const contentRows = await getBubblesByKeys([...new Set(contentKeys)])
    for (const row of contentRows) {
      if (row.value) {
        content.set(row.key, row.value)
      }
    }
  }

  return { composers, conversations, content }
}

// ── Phase 3: Process candidates using pre-fetched data ───────────────

function processCandidates(
  candidates: BubbleCandidate[],
  prefetched: PrefetchedData
): ProcessedChange[] {
  const changes: ProcessedChange[] = []

  for (const candidate of candidates) {
    try {
      const change = processBubbleWithPrefetch(candidate, prefetched)
      trackToolCallId(candidate.toolCallId)
      if (change) {
        changes.push(change)
      }
    } catch {
      trackToolCallId(candidate.toolCallId)
    }
  }

  return changes
}

function processBubbleWithPrefetch(
  candidate: BubbleCandidate,
  prefetched: PrefetchedData
): ProcessedChange | undefined {
  const { bubbleData, composerId } = candidate
  const toolName = bubbleData.toolFormerData?.name
  const toolResult = bubbleData.toolFormerData?.result
  if (!toolResult) {
    return
  }

  const createdAt = new Date(bubbleData.createdAt)
  const composerData = prefetched.composers.get(composerId)
  const model = composerData?.modelConfig?.modelName
  if (!composerData || !model) {
    return
  }

  if (toolName === 'edit_file_v2') {
    return processEditFileV2WithPrefetch(
      bubbleData,
      createdAt,
      composerId,
      composerData,
      model,
      prefetched
    )
  }

  // For other tools, require codeBlockId
  const codeBlockId = bubbleData.toolFormerData?.additionalData?.codeblockId
  if (!codeBlockId) {
    logger.debug(
      {
        toolName,
        toolCallId: bubbleData.toolFormerData?.toolCallId,
        status: bubbleData.toolFormerData?.status,
        hasAdditionalData: !!bubbleData.toolFormerData?.additionalData,
      },
      'processBubble: no codeBlockId'
    )
    return
  }

  const additions = extractAdditions(toolResult)
  const conversation = extractConversationFromPrefetch(
    composerData,
    createdAt,
    composerId,
    prefetched.conversations
  )
  const filePath = extractFilePath(bubbleData)

  return {
    additions,
    conversation,
    createdAt,
    model,
    type: AiBlameInferenceType.Chat,
    composerId,
    filePath,
  }
}

function processEditFileV2WithPrefetch(
  bubbleData: BubbleData,
  createdAt: Date,
  composerId: string,
  composerData: ComposerData,
  model: string,
  prefetched: PrefetchedData
): ProcessedChange | undefined {
  const toolResult = bubbleData.toolFormerData?.result
  if (!toolResult) {
    return
  }

  let result: EditFileV2Result
  try {
    result = JSON.parse(toolResult) as EditFileV2Result
  } catch {
    return
  }

  const { beforeContentId, afterContentId } = result
  if (!afterContentId) {
    return
  }

  const beforeContent = beforeContentId
    ? (prefetched.content.get(beforeContentId) ?? '')
    : ''
  const afterContent = prefetched.content.get(afterContentId)

  if (afterContent === undefined) {
    logger.debug(
      { beforeContentId, afterContentId },
      'processEditFileV2: afterContent not found in prefetch'
    )
    return
  }

  const additions = extractAdditionsFromDiff(beforeContent, afterContent)
  const conversation = extractConversationFromPrefetch(
    composerData,
    createdAt,
    composerId,
    prefetched.conversations
  )
  const filePath = extractFilePath(bubbleData)

  return {
    additions,
    conversation,
    createdAt,
    model,
    type: AiBlameInferenceType.Chat,
    composerId,
    filePath,
  }
}

// ── Main entry point ─────────────────────────────────────────────────

/**
 * Process bubble rows in two phases:
 *
 * Phase 1 (DB open): Filter rows, batch-prefetch all needed data (~3 queries)
 * Phase 2 (DB closed): Process candidates using pre-fetched maps (pure CPU)
 *
 * This minimizes SHARED lock time on Cursor's database and ensures the
 * connection is released before CPU-heavy processing begins.
 */
export async function processBubbles(
  rows: DBRow[],
  startupTimestamp: Date,
  batchLimit: number = Infinity
): Promise<ProcessBubblesResult> {
  // Phase 1a: Filter and collect candidates (no DB access)
  const { candidates, latestTimestamp, hasMore } = filterRows(
    rows,
    startupTimestamp,
    batchLimit
  )

  if (candidates.length === 0) {
    return { changes: [], latestTimestamp, hasMore }
  }

  // Phase 1b: Batch-prefetch all needed data (~3 DB queries)
  // Always release the connection afterward, even if prefetch throws —
  // otherwise a failed batch query could leave SHARED locks held.
  let prefetched: PrefetchedData
  try {
    prefetched = await prefetchAllData(candidates)
  } finally {
    await releaseConnection()
  }

  // Phase 2: Process using pre-fetched data (no DB access, pure CPU)
  const changes = processCandidates(candidates, prefetched)

  return { changes, latestTimestamp, hasMore }
}

// ── Pure functions (no DB access) ────────────────────────────────────

/**
 * Compute additions by diffing before and after content.
 * Uses the 'diff' library to generate a line-by-line diff.
 */
function extractAdditionsFromDiff(
  beforeContent: string,
  afterContent: string
): string {
  const changes = diffLines(beforeContent, afterContent)
  const additions: string[] = []

  for (const change of changes) {
    if (change.added) {
      const lines = change.value.split('\n')
      for (const line of lines) {
        if (line || lines.indexOf(line) < lines.length - 1) {
          additions.push(line)
        }
      }
    }
  }

  while (additions.length > 0 && additions[additions.length - 1] === '') {
    additions.pop()
  }

  return additions.join('\n')
}

function extractAdditions(toolFormerDataResult: string): string {
  const result = JSON.parse(toolFormerDataResult) as unknown as ToolResult

  const additions = []

  for (const chunk of result.diff?.chunks || []) {
    if (chunk.diffString) {
      for (const line of chunk.diffString.split('\n')) {
        if (line.startsWith('+ ')) {
          additions.push(line.substring(2))
        }
      }
    }
  }

  return additions.join('\n')
}

/**
 * Extract conversation bubbles from pre-fetched data.
 * No DB access — reads from the prefetched conversations map.
 */
function extractConversationFromPrefetch(
  composerData: ComposerData,
  bubbleTimestamp: Date,
  composerId: string,
  conversations: Map<string, DBRow>
): BubbleData[] {
  const headers = composerData.fullConversationHeadersOnly || []
  if (headers.length === 0) {
    return []
  }

  const conversationItems: BubbleData[] = []

  for (const step of headers) {
    const key = `bubbleId:${composerId}:${step.bubbleId}`
    const bubbleRow = conversations.get(key)

    if (!bubbleRow?.value) {
      continue
    }

    const bubbleData = JSON.parse(bubbleRow.value) as unknown as BubbleData

    if (
      !bubbleData.text &&
      !bubbleData?.toolFormerData?.result &&
      !bubbleData?.thinking?.text
    ) {
      continue
    }

    conversationItems.push(bubbleData)
  }

  // Filter to items created on/before bubbleTimestamp (handles Cursor write delays)
  return conversationItems
    .filter((item) => new Date(item.createdAt) <= bubbleTimestamp)
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    )
}
