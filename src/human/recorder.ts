import * as path from 'path'
import * as vscode from 'vscode'

import { logger } from '../shared/logger'
import { AppType } from '../shared/repositoryInfo'
import { Segment } from './segmenter'
import { SegmentClassificationCode } from './types'
import type { HumanSegmentUpload } from './uploader'
import { uploadHumanChangesFromExtension } from './uploader'

/** Non-whitespace character count (excludes formatting/indentation). */
function countNonWhitespaceChars(text: string): number {
  return (text || '').replace(/\s/g, '').length
}

/**
 * Builds artifacts for HUMAN segments and uploads them.
 * Above the non-whitespace character threshold → immediate upload.
 * Below threshold → segment is discarded. Non-human segments are skipped.
 */
export class HumanRecorder {
  private readonly uploadEnabled: boolean
  private readonly minSegmentCharsWithNoWhitespace: number
  private readonly appType: AppType

  constructor(opts: {
    uploadEnabled: boolean
    minSegmentCharsWithNoWhitespace: number
    appType: AppType
  }) {
    this.uploadEnabled = opts.uploadEnabled
    // Default 0 to keep tests backward compatible; extension passes real value from constants.
    this.minSegmentCharsWithNoWhitespace = opts.minSegmentCharsWithNoWhitespace
    this.appType = opts.appType
  }

  /** Processes closed segment: upload if meets threshold, discard if not. */
  async record(
    segment: Segment,
    segmentClassification: SegmentClassificationCode
  ) {
    // Count non-whitespace characters for threshold check
    const nonWhitespaceChars = countNonWhitespaceChars(segment.textContent)

    // Check threshold: upload if met, discard if not
    if (nonWhitespaceChars >= this.minSegmentCharsWithNoWhitespace) {
      const uploadPayload: HumanSegmentUpload = {
        timestamp: new Date(segment.endedAt).toISOString(),
        uri: segment.documentUri,
        fileName: path.basename(segment.fileName),
        relativePath: vscode.workspace.asRelativePath(segment.fileName, false),
        startLine: segment.rangeStartLine,
        endLine: segment.rangeEndLineExclusive,
        changedLines: segment.textContent,
        appType: this.appType,
        metrics: {
          durationMs: segment.endedAt - segment.startedAt,
          totalInserted: segment.textContent.length,
        },
        segmentClassification,
      }
      await this.uploadHumanWrittenText(uploadPayload)
      return
    }
    logger.info(
      `Human Code: SKIP upload (below threshold: ${nonWhitespaceChars}/${this.minSegmentCharsWithNoWhitespace})`
    )
    return
  }

  /** Uploads to S3 or logs dry-run. Emits safe telemetry (metadata only). */
  private async uploadHumanWrittenText(segmentUpload: HumanSegmentUpload) {
    try {
      const charCount = segmentUpload.changedLines.length
      if (this.uploadEnabled) {
        await uploadHumanChangesFromExtension(segmentUpload)
        logger.info(
          `Human Code: uploading one segment with chars=${charCount}, file=${segmentUpload.relativePath}`
        )
      } else {
        logger.debug(
          `Human Code: DRY-RUN (upload disabled) — one segment to be uploaded with chars=${charCount}, 
          file=${segmentUpload.relativePath}, content=${segmentUpload.changedLines}`
        )
      }
    } catch (err) {
      logger.error({ err }, 'Human upload failed (see Datadog for stack)')
    }
  }
}
