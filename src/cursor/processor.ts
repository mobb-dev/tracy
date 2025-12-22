import { AiBlameInferenceType } from '../mobbdev_src/features/analysis/scm/generates/client_generates'
import { logger } from '../shared/logger'
import { DBRow, getRowsByLike } from './db'

const processedBubbleIds = new Set<string>()

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
}

export function resetProcessedBubbles() {
  processedBubbleIds.clear()
}

export function ignoreBubbles(rows: DBRow[]) {
  for (const row of rows) {
    processedBubbleIds.add(row.key)
  }
}

export async function processBubbles(
  rows: DBRow[],
  startupTimestamp: Date
): Promise<ProcessedChange[]> {
  const changes: ProcessedChange[] = []

  for (const row of rows) {
    const change = await processBubble(row.key, startupTimestamp)

    if (change) {
      changes.push(change)
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

async function processBubble(
  bubbleKey: string,
  startupTimestamp: Date
): Promise<ProcessedChange | undefined> {
  if (processedBubbleIds.has(bubbleKey)) {
    return
  }

  const bubbleRows = await getRowsByLike({
    key: bubbleKey,
    keyOnly: false,
  })
  const bubbleRow = bubbleRows.at(0)

  if (!bubbleRow?.value) {
    return
  }

  const bubbleData = JSON.parse(bubbleRow.value) as unknown as BubbleData

  if (!bubbleData) {
    return
  }

  const createdAt = new Date(bubbleData.createdAt)

  if (createdAt < startupTimestamp) {
    processedBubbleIds.add(bubbleRow.key)
    return
  }

  if (bubbleData.toolFormerData?.status !== 'completed') {
    return
  }

  if (bubbleData.toolFormerData?.userDecision === 'rejected') {
    return
  }

  const codeBlockId = bubbleData.toolFormerData?.additionalData?.codeblockId

  if (!codeBlockId) {
    return
  }

  const composerDataRows = await getRowsByLike({
    key: 'composerData:%',
    value: `%${codeBlockId}%`,
    keyOnly: false,
  })
  const composerRow = composerDataRows.at(0)

  if (!composerRow?.value) {
    processedBubbleIds.add(bubbleRow.key)
    return
  }

  const composerData = JSON.parse(composerRow.value) as unknown as ComposerData
  const model = composerData.modelConfig?.modelName

  if (!model) {
    processedBubbleIds.add(bubbleRow.key)
    return
  }

  const additions = extractAdditions(bubbleData.toolFormerData?.result)
  const conversation = await extractConversation(composerData, createdAt)

  const result: ProcessedChange = {
    additions,
    conversation,
    createdAt,
    model,
    type: AiBlameInferenceType.Chat,
  }

  processedBubbleIds.add(bubbleRow.key)
  logger.info(`Processed bubble: ${bubbleRow.key}`)

  return result
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
