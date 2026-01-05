import {
  PromptItemArray,
  uploadAiBlameHandlerFromExtension,
  type UploadAiBlameResult,
} from '../mobbdev_src/args/commands/upload_ai_blame'
import { AiBlameInferenceType } from '../mobbdev_src/features/analysis/scm/generates/client_generates'
import { logger } from '../shared/logger'
import { AppType } from '../shared/repositoryInfo'
import {
  type SegmentClassificationCode,
  TOOL_NAME_HUMAN_TYPING,
  UPLOAD_MODEL_HUMAN,
  UPLOAD_TOOL_CURSOR,
  UPLOAD_TOOL_VSCODE,
} from './types'

/** Human code segment upload payload (IDE-side). */
export type HumanSegmentUpload = {
  timestamp: string
  uri: string
  fileName: string
  relativePath: string
  startLine: number
  endLine: number
  changedLines: string
  appType: AppType
  metrics: {
    durationMs: number
    totalInserted: number
  }
  segmentClassification: SegmentClassificationCode
}

/** Uploads human segments to backend using shared handler. */
export async function uploadHumanChangesFromExtension(
  segment: HumanSegmentUpload
): Promise<void> {
  const artifacts = buildHumanUploadArtifact(segment)

  try {
    const result: UploadAiBlameResult = await uploadAiBlameHandlerFromExtension(
      {
        prompts: artifacts.prompts,
        inference: artifacts.inference,
        model: artifacts.model,
        tool: artifacts.tool,
        responseTime: new Date().toISOString(),
        blameType: AiBlameInferenceType.HumanEdit,
      }
    )

    // Log sanitization counts with metadata
    logger.info(
      {
        event: 'human_upload_sanitization',
        timestamp: new Date().toISOString(),
        uri: segment.uri,
        fileName: segment.fileName,
        relativePath: segment.relativePath,
        promptsUUID: result.promptsUUID,
        inferenceUUID: result.inferenceUUID,
        promptsCounts: result.promptsCounts.detections,
        inferenceCounts: result.inferenceCounts.detections,
        totalDetections:
          result.promptsCounts.detections.total +
          result.inferenceCounts.detections.total,
        appType: segment.appType,
        segmentClassification: segment.segmentClassification,
      },
      'Human upload sanitization metrics'
    )
  } catch (error) {
    logger.error({ error, segment }, 'Failed to upload human changes')
    throw error
  }
}

/** Builds prompts/inference for backend. */
function buildHumanUploadArtifact(segment: HumanSegmentUpload): {
  prompts: PromptItemArray
  inference: string
  model: string
  tool: string
} {
  // Build prompts: one TOOL_EXECUTION per segment with name 'human_typing'
  const prompts: PromptItemArray = [
    {
      type: 'TOOL_EXECUTION',
      attachedFiles: [
        {
          relativePath: segment.relativePath || segment.fileName,
          startLine: segment.startLine,
        },
      ],
      text: '...',
      date: new Date(segment.timestamp),
      tool: {
        name: TOOL_NAME_HUMAN_TYPING,
        parameters: JSON.stringify({
          uri: segment.uri,
          fileName: segment.fileName,
          relativePath: segment.relativePath,
          startLine: segment.startLine,
          endLine: segment.endLine,
          changedLines: segment.changedLines,
          metrics: segment.metrics,
          segmentClassification: segment.segmentClassification,
        }),
        result: '...',
      },
    },
  ]

  const inference = segment.changedLines.trim()
  return {
    prompts,
    inference,
    model: UPLOAD_MODEL_HUMAN,
    tool:
      segment.appType === AppType.VSCODE
        ? UPLOAD_TOOL_VSCODE
        : UPLOAD_TOOL_CURSOR,
  }
}
