import * as vscode from 'vscode'

import { ProcessedChange } from '../cursor/processor'
import {
  PromptItemArray,
  uploadAiBlameHandlerFromExtension,
  type UploadAiBlameResult,
} from '../mobbdev_src/args/commands/upload_ai_blame'
import { getAuthenticatedGQLClient } from '../mobbdev_src/commands/handleMobbLogin'
import { AiBlameInferenceType } from '../mobbdev_src/features/analysis/scm/generates/client_generates'
import { detectMCPServers } from '../mobbdev_src/mcp'
import { logger } from './logger'

export async function getAuthenticatedForUpload() {
  logger.info('Getting authenticated for ide extension')
  await getAuthenticatedGQLClient({})
}

export async function detectMcps() {
  try {
    const gqlClient = await getAuthenticatedGQLClient({})
    const userInfo = await gqlClient.getUserInfo()
    const userEmail = userInfo?.email

    if (!userEmail) {
      logger.error('Could not retrieve user email for MCP detection')
      return
    }

    // Detect IDE type
    const appName = vscode.env.appName.toLowerCase()
    let ideName: 'cursor' | 'vscode'

    if (appName.includes('visual studio code')) {
      ideName = 'vscode'
    } else if (appName.includes('cursor')) {
      ideName = 'cursor'
    } else {
      logger.error(`Unknown IDE: ${appName}`)
      return
    }

    // Detect MCP servers
    const { organizationId, userName } = await gqlClient.getLastOrg(userEmail)

    if (!organizationId) {
      logger.error(
        `Detecting MCP servers for IDE: ${ideName} is impossible because organization does not exist`
      )
      return
    }

    detectMCPServers({
      ideName,
      userEmail,
      userName,
      organizationId: String(organizationId),
    })
  } catch (e) {
    logger.error('MCP detection failed, continuing with activation', e)
  }
}

export async function uploadCursorChanges(changes: ProcessedChange[]) {
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
      const result: UploadAiBlameResult =
        await uploadAiBlameHandlerFromExtension({
          prompts,
          inference,
          model: change.model,
          tool: 'Cursor',
          responseTime: change.createdAt.toISOString(),
          blameType: change.type,
        })

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
          promptsCounts: {
            pii: result.promptsCounts.pii,
            secrets: result.promptsCounts.secrets,
          },
          inferenceCounts: {
            pii: result.inferenceCounts.pii,
            secrets: result.inferenceCounts.secrets,
          },
          totalPII:
            result.promptsCounts.pii.total + result.inferenceCounts.pii.total,
          totalSecrets:
            result.promptsCounts.secrets + result.inferenceCounts.secrets,
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
  blameType: AiBlameInferenceType = AiBlameInferenceType.Chat
) {
  logger.info(`Uploading Copilot changes`)

  try {
    const result: UploadAiBlameResult = await uploadAiBlameHandlerFromExtension(
      {
        prompts,
        inference: additions,
        model,
        tool: 'Copilot',
        responseTime,
        blameType,
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
        promptsUUID: result.promptsUUID,
        inferenceUUID: result.inferenceUUID,
        promptsCounts: {
          pii: result.promptsCounts.pii,
          secrets: result.promptsCounts.secrets,
        },
        inferenceCounts: {
          pii: result.inferenceCounts.pii,
          secrets: result.inferenceCounts.secrets,
        },
        totalPII:
          result.promptsCounts.pii.total + result.inferenceCounts.pii.total,
        totalSecrets:
          result.promptsCounts.secrets + result.inferenceCounts.secrets,
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
