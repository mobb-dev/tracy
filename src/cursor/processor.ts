import { diffLines } from 'diff'

import { AiBlameInferenceType } from '../mobbdev_src/features/analysis/scm/generates/client_generates'
import { logger } from '../shared/logger'
import { DBRow, getComposerContent, getRowsByLike } from './db'

// Track uploaded inferences by toolCallId
// toolCallId exists for all completed tool calls (both accepted and rejected)
const uploadedToolCallIds = new Set<string>()

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

export function resetProcessedBubbles() {
  uploadedToolCallIds.clear()
}

/**
 * Mark existing completed inferences as already processed.
 * This scans bubbles with completed status and toolCallId to avoid re-uploading old inferences.
 */
export function markExistingToolCallsAsUploaded(rows: DBRow[]) {
  for (const row of rows) {
    if (!row.value) {
      continue
    }

    try {
      const bubbleData = JSON.parse(row.value) as unknown as BubbleData
      const toolCallId = bubbleData.toolFormerData?.toolCallId
      const status = bubbleData.toolFormerData?.status

      if (toolCallId && status === 'completed') {
        uploadedToolCallIds.add(toolCallId)
      }
    } catch {
      // Skip bubbles that can't be parsed
    }
  }
}

export async function processBubbles(
  rows: DBRow[],
  startupTimestamp: Date
): Promise<ProcessedChange[]> {
  const changes: ProcessedChange[] = []

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
        uploadedToolCallIds.add(toolCallId)
        continue
      }

      const change = await processBubble(row)

      // Always mark as seen to avoid infinite retries, even if processing fails
      uploadedToolCallIds.add(toolCallId)

      if (change) {
        changes.push(change)
      }
    } catch {
      // Skip bubbles that can't be parsed
    }
  }

  return changes
}

type ToolResult = {
  diff?: {
    chunks?: {
      diffString?: string
    }[]
  }
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
 */
async function processBubble(
  bubbleRow: DBRow
): Promise<ProcessedChange | undefined> {
  // Value already validated by caller, but double-check
  if (!bubbleRow.value) {
    logger.debug('processBubble: no value')
    return
  }

  const bubbleData = JSON.parse(bubbleRow.value) as unknown as BubbleData
  const toolName = bubbleData.toolFormerData?.name
  const toolCallId = bubbleData.toolFormerData?.toolCallId
  const toolStatus = bubbleData.toolFormerData?.status

  if (toolStatus !== 'completed') {
    logger.debug({ toolStatus }, 'processBubble: not completed')
    return
  }

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
      bubbleRow.key
    )
  }

  // For other tools, require codeBlockId
  const codeBlockId = bubbleData.toolFormerData?.additionalData?.codeblockId

  if (!codeBlockId) {
    logger.debug(
      {
        toolName,
        toolCallId,
        status: toolStatus,
        hasAdditionalData: !!bubbleData.toolFormerData?.additionalData,
      },
      'processBubble: no codeBlockId'
    )
    return
  }

  const composerDataRows = await getRowsByLike({
    key: 'composerData:%',
    value: `%${codeBlockId}%`,
    keyOnly: false,
  })
  const composerRow = composerDataRows.at(0)

  if (!composerRow?.value) {
    logger.debug(
      { codeBlockId, composerDataRowsCount: composerDataRows.length },
      'processBubble: no composerRow'
    )
    return
  }

  const composerData = JSON.parse(composerRow.value) as unknown as ComposerData
  const model = composerData.modelConfig?.modelName

  // Extract composerId from composer row key (format: composerData:<composerId>)
  const composerId = composerRow.key.split(':')[1]

  if (!model) {
    logger.debug(
      { composerId, hasModelConfig: !!composerData.modelConfig },
      'processBubble: no model'
    )
    return
  }

  const additions = extractAdditions(toolResult)
  const conversation = await extractConversation(composerData, createdAt)

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
  bubbleKey: string
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

  // Look up composer data by composerId
  const composerDataRows = await getRowsByLike({
    key: `composerData:${composerId}`,
    keyOnly: false,
  })
  const composerRow = composerDataRows.at(0)

  if (!composerRow?.value) {
    logger.debug(
      { composerId, composerDataRowsCount: composerDataRows.length },
      'processEditFileV2Bubble: no composerRow found'
    )
    return
  }

  const composerData = JSON.parse(composerRow.value) as unknown as ComposerData
  const model = composerData.modelConfig?.modelName

  if (!model) {
    logger.debug(
      { composerId, hasModelConfig: !!composerData.modelConfig },
      'processEditFileV2Bubble: no model found'
    )
    return
  }

  const conversation = await extractConversation(composerData, createdAt)

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

async function extractConversation(
  composerData: ComposerData,
  bubbleTimestamp: Date
): Promise<BubbleData[]> {
  const conversationItems: BubbleData[] = []

  for (const step of composerData.fullConversationHeadersOnly || []) {
    const bubbleRows = await getRowsByLike({
      key: `bubbleId:%:${step.bubbleId}`,
      keyOnly: false,
    })
    const bubbleRow = bubbleRows.at(0)

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
