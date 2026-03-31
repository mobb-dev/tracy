import {
  type BubbleDataForFilePath,
  extractFilePath,
} from '../cursor/extractFilePath'
import type { CursorRawRecord } from '../cursor/rawProcessor'
import { advanceCursor, SESSION_BUBBLES_LIMIT } from '../cursor/rawProcessor'
import {
  PromptItemArray,
  uploadAiBlameHandlerFromExtension,
  type UploadAiBlameResult,
} from '../mobbdev_src/args/commands/upload_ai_blame'
import {
  prepareAndSendTracyRecords,
  type TracyRecordClientInput,
} from '../mobbdev_src/features/analysis/graphql/tracy-batch-upload'
import {
  AiBlameInferenceType,
  InferencePlatform,
} from '../mobbdev_src/features/analysis/scm/generates/client_generates'
import { getConfig } from './config'
import { createGQLClient } from './gqlClientFactory'
import { logger } from './logger'
import { getNormalizedRepoUrl } from './repositoryInfo'

type BubbleWithTimestamp = BubbleDataForFilePath & { createdAt?: string }

/**
 * Upload tracy records via the shared batch upload pipeline.
 * Handles GQL client creation and logging.
 * Throws on any failure so callers can avoid advancing cursors.
 */
export async function uploadTracyRecords(
  records: TracyRecordClientInput[],
  options?: { sanitize?: boolean }
): Promise<void> {
  if (records.length === 0) {
    return
  }

  const client = await createGQLClient()
  const result = await prepareAndSendTracyRecords(
    client,
    records,
    undefined,
    options
  )
  if (!result.ok) {
    logger.error({ errors: result.errors }, 'Tracy batch upload had errors')
    throw new Error('Tracy batch upload had errors')
  }
}

/**
 * Upload raw Cursor chat bubbles via the tracy batch pipeline.
 * Maps CursorRawRecord[] → TracyRecordClientInput[] with per-record repo resolution.
 */
export async function uploadCursorRawRecords(
  records: CursorRawRecord[],
  incompleteBubbles?: Map<string, { key: string; firstSeenAt: number }[]>,
  maxRowIds?: Map<string, number>,
  bubblesLimit?: number
): Promise<{ uploaded: number }> {
  if (records.length === 0) {
    return { uploaded: 0 }
  }

  const config = getConfig()

  // Cache repo URL lookups within the batch (store Promise to avoid concurrent duplicate calls)
  const repoUrlCache = new Map<string | undefined, Promise<string | null>>()

  const tracyRecords: TracyRecordClientInput[] = await Promise.all(
    records.map(async (record) => {
      // Resolve per-record repo URL from bubble file path
      const bubble = record.bubble as BubbleWithTimestamp
      const filePath = extractFilePath(bubble)

      if (!repoUrlCache.has(filePath)) {
        repoUrlCache.set(filePath, getNormalizedRepoUrl(filePath))
      }
      const repositoryUrl = await repoUrlCache.get(filePath)!

      // Strip internal fields from rawData sent to server
      const {
        rowid: _rowid,
        bubblesFetched: _bubblesFetched,
        ...serverMetadata
      } = record.metadata
      return {
        platform: InferencePlatform.Cursor,
        blameType: AiBlameInferenceType.Chat,
        recordId: record.metadata.recordId,
        recordTimestamp: bubble.createdAt ?? new Date().toISOString(),
        rawData: { bubble: record.bubble, metadata: serverMetadata },
        repositoryUrl: repositoryUrl ?? undefined,
        clientVersion: config.extensionVersion,
      }
    })
  )

  try {
    await uploadTracyRecords(tracyRecords, {
      sanitize: config.sanitizeData,
    })

    // Advance cursors per session after successful upload.
    // Track the record with the highest rowid per session (not just last-iterated,
    // since revisited incomplete bubbles may have lower rowids than new records).
    const lastRecordPerSession = new Map<
      string,
      {
        recordId: string
        timestamp: string
        rowid?: number
        bubblesFetched?: number
      }
    >()
    for (const record of records) {
      const bubble = record.bubble as BubbleWithTimestamp
      const prev = lastRecordPerSession.get(record.metadata.sessionId)
      const prevRowId = prev?.rowid ?? -1
      const curRowId = record.metadata.rowid ?? -1
      if (curRowId >= prevRowId) {
        lastRecordPerSession.set(record.metadata.sessionId, {
          recordId: record.metadata.recordId,
          timestamp: bubble.createdAt ?? new Date().toISOString(),
          rowid: record.metadata.rowid,
          bubblesFetched: record.metadata.bubblesFetched,
        })
      }
    }
    for (const [
      sessionId,
      { recordId, timestamp, rowid, bubblesFetched },
    ] of lastRecordPerSession) {
      const pending =
        (bubblesFetched ?? 0) >= (bubblesLimit ?? SESSION_BUBBLES_LIMIT)
      // Use maxRowId (covers skipped bubbles) if available, else record's rowid
      const effectiveRowId = maxRowIds?.get(sessionId) ?? rowid
      try {
        advanceCursor(sessionId, {
          recordId,
          timestamp,
          lastRowId: effectiveRowId,
          pending,
          incompleteBubbles: incompleteBubbles?.get(sessionId),
        })
      } catch (cursorErr) {
        logger.error(
          { err: cursorErr },
          `Failed to advance cursor for session ${sessionId}, will re-upload on next poll`
        )
      }
    }

    logger.info(
      `Tracy upload: ${records.length} records from ${lastRecordPerSession.size} session(s)`
    )
    return { uploaded: records.length }
  } catch (err) {
    logger.error({ err }, 'Failed to upload cursor raw records')
    throw err
  }
}

/**
 * Upload Copilot changes via the legacy upload path.
 * Kept until Copilot is migrated to tracy batch uploads.
 */
export async function uploadCopilotChanges(
  prompts: PromptItemArray,
  additions: string,
  model: string,
  responseTime: string,
  blameType: AiBlameInferenceType = AiBlameInferenceType.Chat,
  sessionId?: string,
  filePath?: string
) {
  logger.info(`Uploading Copilot changes`, { sessionId })

  try {
    const config = getConfig()
    const repositoryUrl = await getNormalizedRepoUrl(filePath)
    logger.debug(
      { filePath, repositoryUrl, sessionId },
      'Copilot per-change repo resolution'
    )
    const result: UploadAiBlameResult = await uploadAiBlameHandlerFromExtension(
      {
        prompts,
        inference: additions,
        model,
        tool: 'Copilot',
        responseTime,
        blameType,
        sessionId,
        apiUrl: config.apiUrl,
        webAppUrl: config.webAppUrl,
        repositoryUrl,
        sanitize: config.sanitizeData,
      }
    )
    logger.info(
      { data: { tool: 'Copilot', model, repositoryUrl } },
      'Inference uploaded'
    )

    logger.info(
      {
        event: 'copilot_upload_sanitization',
        sanitizationEnabled: config.sanitizeData,
        timestamp: new Date().toISOString(),
        model,
        tool: 'Copilot',
        blameType,
        sessionId,
        promptsUUID: result.promptsUUID,
        inferenceUUID: result.inferenceUUID,
        promptsCounts: result.promptsCounts.detections,
        inferenceCounts: result.inferenceCounts.detections,
        totalDetections:
          result.promptsCounts.detections.total +
          result.inferenceCounts.detections.total,
        sanitizationDurationMs: result.sanitizationDurationMs,
      },
      config.sanitizeData
        ? 'Copilot upload sanitization metrics'
        : 'Copilot upload (sanitization disabled)'
    )
  } catch (error) {
    logger.error(
      { error, model, tool: 'Copilot' },
      'Failed to upload copilot changes'
    )
    throw error
  }
}
