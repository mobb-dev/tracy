import {
  EditType,
  InferencePlatform,
} from '../mobbdev_src/features/analysis/scm/generates/client_generates'
import { sanitizeData } from '../mobbdev_src/utils/sanitize-sensitive-data'
import { getConfig } from '../shared/config'
import { logger } from '../shared/logger'
import { AppType, getNormalizedRepoUrl } from '../shared/repositoryInfo'
import { uploadTracyRecords } from '../shared/uploader'
import type { SegmentClassificationCode } from './types'

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

/** Uploads human segments via the tracy batch pipeline. */
export async function uploadHumanChangesFromExtension(
  segment: HumanSegmentUpload
): Promise<void> {
  const platform =
    segment.appType === AppType.VSCODE
      ? InferencePlatform.ClaudeCode
      : InferencePlatform.Cursor

  try {
    const config = getConfig()
    const repositoryUrl = await getNormalizedRepoUrl(segment.uri)
    const trimmed = segment.changedLines.trim()
    const additions = config.sanitizeData
      ? String(await sanitizeData(trimmed))
      : trimmed

    await uploadTracyRecords([
      {
        platform,
        recordId: crypto.randomUUID(),
        recordTimestamp: segment.timestamp,
        editType: EditType.HumanEdit,
        additions,
        filePath: segment.relativePath || segment.fileName,
        repositoryUrl: repositoryUrl ?? undefined,
        clientVersion: getConfig().extensionVersion,
      },
    ])
  } catch (error) {
    logger.error({ error, segment }, 'Failed to upload human changes')
    throw error
  }
}
