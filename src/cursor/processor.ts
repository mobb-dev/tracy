import { AiBlameInferenceType } from '../mobbdev_src/features/analysis/scm/generates/client_generates'
import { logger } from '../shared/logger'
import { DBRow, getRowsByLike } from './db'

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
 * Process a single bubble row that has already been pre-filtered
 * to have a codeblockId (indicating a completed edit) and valid timestamp.
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
  const codeBlockId = bubbleData.toolFormerData?.additionalData?.codeblockId

  if (!codeBlockId) {
    logger.debug(
      {
        toolName: bubbleData.toolFormerData?.name,
        toolCallId: bubbleData.toolFormerData?.toolCallId,
        status: bubbleData.toolFormerData?.status,
        hasAdditionalData: !!bubbleData.toolFormerData?.additionalData,
      },
      'processBubble: no codeBlockId'
    )
    return
  }

  const toolStatus = bubbleData.toolFormerData?.status

  if (toolStatus !== 'completed') {
    logger.debug({ toolStatus }, 'processBubble: not completed')
    return
  }

  const createdAt = new Date(bubbleData.createdAt)

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

  const toolResult = bubbleData.toolFormerData?.result
  if (!toolResult) {
    logger.debug('processBubble: no toolResult')
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
