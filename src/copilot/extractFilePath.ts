import * as path from 'node:path'

import { fileUriToFsPath } from '../mobbdev_src/utils/url'
import { logger } from '../shared/logger'

/**
 * Cross-platform "is this an absolute path?" check. Node's default
 * `path.isAbsolute` uses the host-platform semantics and rejects Windows
 * paths like `C:\Users\...` when called on POSIX. The extension can see
 * Windows paths even when unit tests run on a POSIX CI host, so accept
 * anything that either POSIX or Win32 considers absolute.
 */
function isAnyAbsolute(p: string): boolean {
  return path.posix.isAbsolute(p) || path.win32.isAbsolute(p)
}

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
      const filePath = fileUriToFsPath(uri) ?? uri
      if (isAnyAbsolute(filePath)) {
        logger.debug(
          { toolId: item.toolId, filePath, source: 'invocationMessage.uris' },
          'extractFilePathFromRecord: resolved'
        )
        return filePath
      }
    }
  }

  // Strategy 2: textEditGroup uri.path.
  //
  // `uri.path` is the URI path component (e.g. "/C:/Users/test/foo.ts" on
  // Windows), not an fsPath. Reconstruct a file:// URI and run it through
  // the Windows-aware converter so Strategy 2 doesn't leak URI-form paths
  // into downstream repo-URL resolution on Windows.
  //
  // Only reconstruct when the path starts with "/" (URI path component).
  // A bare relative path like "relative/file.ts" would be mangled by
  // `new URL('file://relative/file.ts')` — "relative" becomes the hostname
  // and "/file.ts" becomes the pathname, producing a false absolute path.
  for (const item of response) {
    if (item.kind !== 'textEditGroup') {
      continue
    }
    const rawEditPath = item.uri?.path
    if (!rawEditPath) {
      continue
    }
    const editPath = rawEditPath.startsWith('/')
      ? (fileUriToFsPath(`file://${rawEditPath}`) ?? rawEditPath)
      : rawEditPath
    if (isAnyAbsolute(editPath)) {
      logger.debug(
        { filePath: editPath, source: 'textEditGroup.uri.path' },
        'extractFilePathFromRecord: resolved'
      )
      return editPath
    }
  }

  return undefined
}
