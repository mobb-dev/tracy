import { ProcessedChange } from '../cursor/processor'
import {
  PromptItemArray,
  uploadAiBlameHandlerFromExtension,
  type UploadAiBlameResult,
} from '../mobbdev_src/args/commands/upload_ai_blame'
import { AiBlameInferenceType } from '../mobbdev_src/features/analysis/scm/generates/client_generates'
import { getConfig } from './config'
import { logger } from './logger'
import { getNormalizedGitHubRepoUrl } from './repositoryInfo'

export async function uploadCursorChanges(changes: ProcessedChange[]) {
  // Get the normalized GitHub repository URL once for all changes
  const repositoryUrl = await getNormalizedGitHubRepoUrl()

  for (const change of changes) {
    logger.info(
      `Uploading inference for model ${change.model} with createdAt ${change.createdAt.toISOString()}: ${change.additions.slice(0, 100)}...`
    )
    const prompts: PromptItemArray = change.conversation.map((item) => ({
      type:
        item.type === 1
          ? 'USER_PROMPT'
          : item?.toolFormerData?.name
            ? 'TOOL_EXECUTION'
            : item?.thinking?.text
              ? 'AI_THINKING'
              : 'AI_RESPONSE',
      attachedFiles: item.attachedFileCodeChunksMetadataOnly?.map(
        (attachedFile) => ({
          relativePath: attachedFile.relativeWorkspacePath,
          startLine: attachedFile.startLineNumber,
        })
      ),
      tokens: {
        inputCount: item.tokenCount.inputTokens,
        outputCount: item.tokenCount.outputTokens,
      },
      text: item?.thinking?.text || item.text,
      date: new Date(item.createdAt),
      tool: item.toolFormerData
        ? {
            name: item.toolFormerData.name,
            parameters: item.toolFormerData.params,
            result: item.toolFormerData.result,
            rawArguments: item.toolFormerData.rawArgs,
            accepted: item.toolFormerData.userDecision === 'accepted',
          }
        : undefined,
    }))
    const inference = change.additions

    try {
      const config = getConfig()
      logger.info('Starting upload to backend...', {
        apiUrl: config.apiUrl,
        webAppUrl: config.webAppUrl,
        repositoryUrl,
      })
      const result: UploadAiBlameResult =
        await uploadAiBlameHandlerFromExtension({
          prompts,
          inference,
          model: change.model,
          tool: 'Cursor',
          responseTime: change.createdAt.toISOString(),
          blameType: change.type,
          sessionId: change.composerId,
          apiUrl: config.apiUrl,
          webAppUrl: config.webAppUrl,
          repositoryUrl,
        })

      logger.info('Upload completed successfully')

      // Log sanitization counts with metadata
      logger.info(
        {
          event: 'cursor_upload_sanitization',
          timestamp: new Date().toISOString(),
          model: change.model,
          tool: 'Cursor',
          blameType: change.type,
          promptsUUID: result.promptsUUID,
          inferenceUUID: result.inferenceUUID,
          promptsCounts: result.promptsCounts.detections,
          inferenceCounts: result.inferenceCounts.detections,
          totalDetections:
            result.promptsCounts.detections.total +
            result.inferenceCounts.detections.total,
        },
        'Cursor upload sanitization metrics'
      )
    } catch (error) {
      logger.error({ error, change }, 'Failed to upload cursor changes')
      throw error
    }
  }
}

export async function uploadCopilotChanges(
  prompts: PromptItemArray,
  additions: string,
  model: string,
  responseTime: string,
  blameType: AiBlameInferenceType = AiBlameInferenceType.Chat,
  sessionId?: string
) {
  logger.info(`Uploading Copilot changes`, { sessionId })

  try {
    const config = getConfig()
    const repositoryUrl = await getNormalizedGitHubRepoUrl()
    logger.info('Starting Copilot upload to backend...', {
      apiUrl: config.apiUrl,
      webAppUrl: config.webAppUrl,
      repositoryUrl,
    })
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
      }
    )

    // Log sanitization counts with metadata
    logger.info(
      {
        event: 'copilot_upload_sanitization',
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
      },
      'Copilot upload sanitization metrics'
    )
  } catch (error) {
    logger.error(
      { error, model, tool: 'Copilot' },
      'Failed to upload copilot changes'
    )
    throw error
  }
}
