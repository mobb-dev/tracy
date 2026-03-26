import * as path from 'node:path'

import { logger } from '../shared/logger'

/**
 * Minimal bubble data shape needed for file path extraction.
 * Kept minimal so this module has no dependency on the processing pipeline.
 */
export type BubbleDataForFilePath = {
  toolFormerData?: {
    name: string
    rawArgs: string
    params: string
  }
  codeBlocks?: Array<{
    uri: {
      path: string
    }
  }>
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
export function extractFilePath(
  bubbleData: BubbleDataForFilePath
): string | undefined {
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
