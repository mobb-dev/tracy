import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { logger } from '../shared/logger'

type ResponseItem = {
  kind?: string
  toolId?: string
  invocationMessage?: { uris?: Record<string, unknown> }
  uri?: { path?: string }
}

/**
 * Minimal record shape needed for file path extraction.
 */
export type CopilotRecordForFilePath = {
  request: {
    response?: unknown[]
  }
}

/**
 * Extract the first absolute file path from a Copilot raw record.
 *
 * Strategy (ordered by reliability):
 * 1. Walk response[] for toolInvocationSerialized → invocationMessage.uris[]
 * 2. Walk response[] for textEditGroup → uri.path
 * 3. Return undefined (caller falls back to workspace-level resolution)
 */
export function extractFilePathFromRecord(
  record: CopilotRecordForFilePath
): string | undefined {
  const rawResponse = record.request.response
  if (!Array.isArray(rawResponse)) {
    return undefined
  }
  const response = rawResponse as ResponseItem[]

  // Strategy 1: invocationMessage.uris from tool invocations
  for (const item of response) {
    if (item.kind !== 'toolInvocationSerialized') {
      continue
    }
    const uris = item.invocationMessage?.uris
    if (!uris) {
      continue
    }
    for (const uri of Object.keys(uris)) {
      let filePath: string
      try {
        filePath = uri.startsWith('file://') ? fileURLToPath(uri) : uri
      } catch {
        continue
      }
      if (path.isAbsolute(filePath)) {
        logger.debug(
          { toolId: item.toolId, filePath, source: 'invocationMessage.uris' },
          'extractFilePathFromRecord: resolved'
        )
        return filePath
      }
    }
  }

  // Strategy 2: textEditGroup uri.path
  for (const item of response) {
    if (item.kind !== 'textEditGroup') {
      continue
    }
    const editPath = item.uri?.path
    if (editPath && path.isAbsolute(editPath)) {
      logger.debug(
        { filePath: editPath, source: 'textEditGroup.uri.path' },
        'extractFilePathFromRecord: resolved'
      )
      return editPath
    }
  }

  return undefined
}
