import { diffLines } from 'diff'

import { AiBlameInferenceType } from '../mobbdev_src/features/analysis/scm/generates/client_generates'
import { logger } from '../shared/logger'
import {
  DBRow,
  getBubblesByKeys,
  getComposerContent,
  getRowsByLike,
} from './db'

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
}

export type ProcessBubblesResult = {
  changes: ProcessedChange[]
  latestTimestamp: string | null
  hasMore: boolean
}

export function resetProcessedBubbles() {
  uploadedToolCallIds.clear()
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

export async function processBubbles(
  rows: DBRow[],
  startupTimestamp: Date,
  batchLimit: number = Infinity
): Promise<ProcessBubblesResult> {
  const changes: ProcessedChange[] = []
  let latestTimestamp: string | null = null
  let processed = 0
  // Once we encounter a non-completed row, freeze the watermark.
  // Rows are ordered by createdAt ASC, so any completed row AFTER a
  // non-completed one would advance the watermark past the pending row,
  // causing it to be skipped on the next poll (data loss).
  let watermarkFrozen = false

  // Per-poll cache: avoids re-querying the same composerData for multiple bubbles
  // in the same composer (e.g. 10 bubbles in composer X = 1 query instead of 10)
  const composerCache = new Map<string, ComposerData | null>()

  for (const row of rows) {
    if (!row.value) {
      continue
    }

    // Quick pre-filter: check if this bubble has the required fields
    try {
      const bubbleData = JSON.parse(row.value) as unknown as BubbleData
      const toolCallId = bubbleData.toolFormerData?.toolCallId
      const status = bubbleData.toolFormerData?.status
      const createdAt = new Date(bubbleData.createdAt)

      // Only advance the high-water mark for completed rows, and only
      // while we haven't seen any non-completed rows yet. This prevents
      // the watermark from jumping past a "running" bubble that still
      // needs to be re-fetched once it completes.
      if (status !== 'completed') {
        watermarkFrozen = true
      } else if (
        !watermarkFrozen &&
        (!latestTimestamp || bubbleData.createdAt > latestTimestamp)
      ) {
        latestTimestamp = bubbleData.createdAt
      }

      // Skip bubbles without toolCallId or not completed
      if (!toolCallId || status !== 'completed') {
        continue
      }

      // Skip already uploaded toolCallIds
      if (uploadedToolCallIds.has(toolCallId)) {
        continue
      }

      // Skip old bubbles (created before extension startup) and mark as seen
      // so we don't re-check them on every poll
      if (createdAt < startupTimestamp) {
        trackToolCallId(toolCallId)
        continue
      }

      // Check batch limit before processing
      if (processed >= batchLimit) {
        return { changes, latestTimestamp, hasMore: true }
      }

      const change = await processBubble(row, bubbleData, composerCache)

      // Always mark as seen to avoid infinite retries, even if processing fails
      trackToolCallId(toolCallId)

      processed++

      if (change) {
        changes.push(change)
      }
    } catch {
      // Skip bubbles that can't be parsed
    }
  }

  return { changes, latestTimestamp, hasMore: false }
}

type ToolResult = {
  diff?: {
    chunks?: {
      diffString?: string
    }[]
  }
}

/**
 * Look up and cache composerData for a given composerId.
 * Returns cached result on subsequent calls with the same composerId,
 * avoiding redundant DB queries when multiple bubbles share a composer.
 */
async function resolveComposer(
  composerId: string,
  cache: Map<string, ComposerData | null>
): Promise<{ composerData: ComposerData | null; model: string | undefined }> {
  if (cache.has(composerId)) {
    const cached = cache.get(composerId) ?? null
    return { composerData: cached, model: cached?.modelConfig?.modelName }
  }

  const rows = await getRowsByLike({
    key: `composerData:${composerId}`,
    keyOnly: false,
  })
  const row = rows.at(0)

  if (!row?.value) {
    cache.set(composerId, null)
    return { composerData: null, model: undefined }
  }

  const composerData = JSON.parse(row.value) as unknown as ComposerData
  cache.set(composerId, composerData)
  return { composerData, model: composerData.modelConfig?.modelName }
}

/**
 * Result structure for edit_file_v2 tool.
 * Unlike other tools, it stores content IDs instead of inline diffs.
 */
type EditFileV2Result = {
  beforeContentId: string
  afterContentId: string
}

/**
 * Process a single bubble row that has already been pre-filtered
 * to have a completed tool call with valid timestamp.
 * Accepts pre-parsed bubbleData to avoid redundant JSON.parse.
 */
async function processBubble(
  bubbleRow: DBRow,
  bubbleData: BubbleData,
  composerCache: Map<string, ComposerData | null>
): Promise<ProcessedChange | undefined> {
  const toolName = bubbleData.toolFormerData?.name
  const toolCallId = bubbleData.toolFormerData?.toolCallId
  const toolResult = bubbleData.toolFormerData?.result
  if (!toolResult) {
    logger.debug('processBubble: no toolResult')
    return
  }

  const createdAt = new Date(bubbleData.createdAt)

  // Handle edit_file_v2 differently - it has no codeBlockId but has content IDs
  if (toolName === 'edit_file_v2') {
    return processEditFileV2Bubble(
      bubbleData,
      toolCallId,
      createdAt,
      bubbleRow.key,
      composerCache
    )
  }

  // For other tools, require codeBlockId
  const codeBlockId = bubbleData.toolFormerData?.additionalData?.codeblockId

  if (!codeBlockId) {
    logger.debug(
      {
        toolName,
        toolCallId,
        status: bubbleData.toolFormerData?.status,
        hasAdditionalData: !!bubbleData.toolFormerData?.additionalData,
      },
      'processBubble: no codeBlockId'
    )
    return
  }

  // Extract composerId from bubble key (format: bubbleId:{composerId}:{bubbleId})
  const composerId = bubbleRow.key.split(':')[1]

  const { composerData, model } = await resolveComposer(
    composerId,
    composerCache
  )
  if (!composerData || !model) {
    return
  }

  const additions = extractAdditions(toolResult)
  const conversation = await extractConversation(
    composerData,
    createdAt,
    composerId
  )

  return {
    additions,
    conversation,
    createdAt,
    model,
    type: AiBlameInferenceType.Chat,
    composerId,
  }
}

/**
 * Process an edit_file_v2 bubble which has a different structure:
 * - No codeBlockId in additionalData
 * - Result contains beforeContentId and afterContentId instead of diff chunks
 * - Content must be looked up from composer.content.* keys
 */
async function processEditFileV2Bubble(
  bubbleData: BubbleData,
  toolCallId: string | undefined,
  createdAt: Date,
  bubbleKey: string,
  composerCache: Map<string, ComposerData | null>
): Promise<ProcessedChange | undefined> {
  const toolResult = bubbleData.toolFormerData?.result
  if (!toolResult) {
    logger.debug('processEditFileV2Bubble: no toolResult')
    return
  }

  let result: EditFileV2Result
  try {
    result = JSON.parse(toolResult) as EditFileV2Result
  } catch {
    logger.debug('processEditFileV2Bubble: failed to parse toolResult')
    return
  }

  const { beforeContentId, afterContentId } = result
  // afterContentId is required, but beforeContentId can be missing for new file creation
  if (!afterContentId) {
    logger.debug(
      { beforeContentId, afterContentId },
      'processEditFileV2Bubble: missing afterContentId'
    )
    return
  }

  // Look up the actual content from composer.content.* keys
  // For new files, beforeContentId is undefined, so we use empty string as before content
  const [beforeContent, afterContent] = await Promise.all([
    beforeContentId ? getComposerContent(beforeContentId) : Promise.resolve(''),
    getComposerContent(afterContentId),
  ])

  if (afterContent === undefined) {
    logger.debug(
      {
        beforeContentId,
        afterContentId,
        hasBeforeContent: beforeContent !== undefined,
        hasAfterContent: afterContent !== undefined,
      },
      'processEditFileV2Bubble: afterContent not found'
    )
    return
  }

  // Use empty string as fallback for beforeContent (new file case or lookup failure)
  const resolvedBeforeContent = beforeContent ?? ''

  // Compute additions by diffing before and after content
  const additions = extractAdditionsFromDiff(
    resolvedBeforeContent,
    afterContent
  )

  // Extract composerId from bubble key (format: bubbleId:{composerId}:{bubbleId})
  const keyParts = bubbleKey.split(':')
  if (keyParts.length < 2) {
    logger.debug(
      { bubbleKey },
      'processEditFileV2Bubble: invalid bubble key format'
    )
    return
  }
  const composerId = keyParts[1]

  const { composerData, model } = await resolveComposer(
    composerId,
    composerCache
  )
  if (!composerData || !model) {
    return
  }

  const conversation = await extractConversation(
    composerData,
    createdAt,
    composerId
  )

  return {
    additions,
    conversation,
    createdAt,
    model,
    type: AiBlameInferenceType.Chat,
    composerId,
  }
}

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
      // Split by newlines and add each line (removing trailing empty line if present)
      const lines = change.value.split('\n')
      for (const line of lines) {
        // Only add non-empty lines or preserve intentional empty lines within content
        if (line || lines.indexOf(line) < lines.length - 1) {
          additions.push(line)
        }
      }
    }
  }

  // Remove trailing empty string if the last added content ended with newline
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
 * Extract conversation bubbles for a composer.
 * Uses batch fetch (single WHERE IN query) instead of N individual queries.
 */
async function extractConversation(
  composerData: ComposerData,
  bubbleTimestamp: Date,
  composerId: string
): Promise<BubbleData[]> {
  const headers = composerData.fullConversationHeadersOnly || []
  if (headers.length === 0) {
    return []
  }

  // Build exact keys for batch fetch: bubbleId:{composerId}:{bubbleId}
  const keys = headers.map((step) => `bubbleId:${composerId}:${step.bubbleId}`)

  // Single batch query instead of N individual queries
  const rows = await getBubblesByKeys(keys)

  // Build a Map for O(1) lookup
  const rowMap = new Map<string, DBRow>()
  for (const row of rows) {
    rowMap.set(row.key, row)
  }

  const conversationItems: BubbleData[] = []

  for (const step of headers) {
    const key = `bubbleId:${composerId}:${step.bubbleId}`
    const bubbleRow = rowMap.get(key)

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

  //sometimes Cursor writes events to the internal DB with a delay so we get get events that happened after the bubbleTimestamp in the conversation
  //This makes sure we read only events that happened before or at the same time as the bubbleTimestamp
  return conversationItems
    .filter((item) => new Date(item.createdAt) <= bubbleTimestamp)
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    )
}
