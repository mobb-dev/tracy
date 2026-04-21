import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

import * as vscode from 'vscode'

import { extractFilePathFromRecord } from '../copilot/extractFilePath'
import type { CopilotRawRecord } from '../copilot/rawProcessor'
import {
  type BubbleDataForFilePath,
  extractFilePath,
} from '../cursor/extractFilePath'
import type { CursorRawRecord } from '../cursor/rawProcessor'
import { advanceCursor, SESSION_BUBBLES_LIMIT } from '../cursor/rawProcessor'
import {
  hasFileChangedForSession,
  scanContextFiles,
} from '../mobbdev_src/features/analysis/context_file_scanner'
import { runContextFileUploadPipeline } from '../mobbdev_src/features/analysis/context_file_uploader'
import {
  prepareAndSendTracyRecords,
  type TracyRecordClientInput,
} from '../mobbdev_src/features/analysis/graphql/tracy-batch-upload'
import {
  AiBlameInferenceType,
  InferencePlatform,
} from '../mobbdev_src/features/analysis/scm/generates/client_generates'
import { getConfig } from './config'
import { ContextFileWorkerClient } from './contextFileWorkerClient'
import { createGQLClient } from './gqlClientFactory'
import { logger } from './logger'
import {
  getNormalizedRepo,
  type GitRepository,
  repoInfo,
} from './repositoryInfo'

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

  // Cache repo lookups within the batch (store Promise to avoid concurrent duplicate calls).
  const repoCache = new Map<string | undefined, Promise<GitRepository | null>>()

  const tracyRecords: TracyRecordClientInput[] = await Promise.all(
    records.map(async (record) => {
      // Resolve per-record repo from bubble file path
      const bubble = record.bubble as BubbleWithTimestamp
      const filePath = extractFilePath(bubble)

      if (!repoCache.has(filePath)) {
        repoCache.set(filePath, getNormalizedRepo(filePath))
      }
      const repo = await repoCache.get(filePath)!

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
        repositoryUrl: repo?.gitRepoUrl ?? undefined,
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
 * Upload raw Copilot chat requests via the tracy batch pipeline.
 * Maps CopilotRawRecord[] → TracyRecordClientInput[] with per-record repo resolution.
 */
export async function uploadCopilotRawRecords(
  records: CopilotRawRecord[]
): Promise<{ uploaded: number }> {
  if (records.length === 0) {
    return { uploaded: 0 }
  }

  const config = getConfig()

  // Cache repo lookups within the batch (Promise-based to avoid races).
  const repoCache = new Map<string | undefined, Promise<GitRepository | null>>()

  // Attach workspace repo mapping so the server can resolve per-event repo URLs
  const workspaceRepos = repoInfo?.repositories?.map((r) => ({
    gitRoot: r.gitRoot,
    gitRepoUrl: r.gitRepoUrl,
  }))
  const tracyRecords: TracyRecordClientInput[] = await Promise.all(
    records.map(async (record) => {
      const filePath = extractFilePathFromRecord(record)

      if (!repoCache.has(filePath)) {
        repoCache.set(filePath, getNormalizedRepo(filePath))
      }
      const repo = await repoCache.get(filePath)!

      // Inject workspace repos into rawData for server-side per-event resolution
      const rawData: CopilotRawRecord = {
        ...record,
        metadata: {
          ...record.metadata,
          workspaceRepos,
        },
      }

      return {
        platform: InferencePlatform.Copilot,
        blameType: AiBlameInferenceType.Chat,
        recordId: record.request.requestId,
        recordTimestamp: new Date(record.request.timestamp).toISOString(),
        rawData,
        repositoryUrl: repo?.gitRepoUrl ?? undefined,
        clientVersion: config.extensionVersion,
      }
    })
  )

  try {
    await uploadTracyRecords(tracyRecords, {
      sanitize: config.sanitizeData,
    })
    return { uploaded: records.length }
  } catch (err) {
    logger.error({ err }, 'Failed to upload copilot raw records')
    throw err
  }
}

const PLATFORM_TO_ENUM: Record<string, InferencePlatform> = {
  cursor: InferencePlatform.Cursor,
  copilot: InferencePlatform.Copilot,
}

type ExtraFile = {
  name: string
  path: string
  content: string
  sizeBytes: number
  category: string
  mtimeMs: number
}

// Cursor "User Rules" (Settings > Rules > User Rules) are synced to Cursor's
// cloud and NOT cached locally — exhaustive search of ItemTable, cursorDiskKV,
// storage.json, settings.json, and reactiveStorage found no local copy.
// They are injected into prompts server-side. Matches T-451: "Option B
// (upstream cooperation) ruled out — blocked on Cursor's roadmap."

/**
 * Read Copilot's user-level custom instructions from VS Code settings.
 * Returns null if not configured.
 */
function extractCopilotGlobalInstructions(): ExtraFile | null {
  try {
    const config = vscode.workspace.getConfiguration(
      'github.copilot.chat.codeGeneration'
    )
    const instructions = config.get<Array<{ text?: string }> | string>(
      'instructions'
    )
    let content: string | null = null
    if (typeof instructions === 'string') {
      content = instructions.trim() || null
    } else if (Array.isArray(instructions)) {
      const joined = instructions
        .map((i) => i?.text ?? '')
        .filter((t) => t.trim())
        .join('\n\n---\n\n')
      content = joined.trim() || null
    }
    if (!content) {
      return null
    }
    return {
      name: 'copilot-user-instructions',
      path: path.join(homedir(), '.config/github-copilot/user-instructions'),
      content,
      sizeBytes: Buffer.byteLength(content, 'utf-8'),
      category: 'rule',
      // Stable pseudo-mtime derived from content — changes only when content changes,
      // so mtime-based dedup works without access to a real filesystem timestamp.
      mtimeMs: parseInt(
        createHash('md5').update(content).digest('hex').slice(0, 12),
        16
      ),
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to read Copilot user instructions')
    return null
  }
}

// Lazy singleton — created on first context file upload, reused across sessions.
let _contextFileWorker: ContextFileWorkerClient | null = null
function getContextFileWorker(): ContextFileWorkerClient {
  if (!_contextFileWorker) {
    _contextFileWorker = new ContextFileWorkerClient()
  }
  return _contextFileWorker
}

/** Dispose the worker thread. Call from the extension's deactivate() hook. */
export function disposeContextFileWorker(): void {
  _contextFileWorker?.dispose()
  _contextFileWorker = null
}

/**
 * Scan, sanitize (via worker), and upload context files and skills for a session.
 * Each file/skill is uploaded directly to S3 with its own Tracy event.
 * Non-throwing — logs errors and returns false on failure.
 */
export async function uploadContextFilesForSession(
  sessionId: string,
  platform: string
): Promise<boolean> {
  const { workspaceFolders } = vscode.workspace
  if (!workspaceFolders || workspaceFolders.length === 0) {
    logger.info('No workspace folders, skipping context file scan')
    return false
  }

  const platformEnum = PLATFORM_TO_ENUM[platform]
  if (!platformEnum) {
    logger.warn({ platform }, 'Unsupported platform for context file upload')
    return false
  }

  try {
    // Scan all workspace folders — deduplicate regular files by path, skill groups by sessionKey
    const seenFilePaths = new Set<string>()
    const seenSkillKeys = new Set<string>()
    const allRegularFiles: import('../mobbdev_src/features/analysis/context_file_scanner').ContextFileEntry[] =
      []
    const allSkillGroups: import('../mobbdev_src/features/analysis/context_file_scanner').SkillGroup[] =
      []

    for (const folder of workspaceFolders) {
      const { regularFiles, skillGroups } = await scanContextFiles(
        folder.uri.fsPath,
        platform,
        sessionId
      )
      for (const f of regularFiles) {
        if (!seenFilePaths.has(f.path)) {
          seenFilePaths.add(f.path)
          allRegularFiles.push(f)
        }
      }
      for (const sg of skillGroups) {
        if (!seenSkillKeys.has(sg.sessionKey)) {
          seenSkillKeys.add(sg.sessionKey)
          allSkillGroups.push(sg)
        }
      }
    }

    // Append Copilot user-level instructions from VS Code settings.
    // (Cursor "User Rules" are cloud-only — see comment above.)
    // The scanner's mtime filter never sees this synthetic entry because the
    // path doesn't exist on disk, so we check it explicitly here.
    if (platform === 'copilot') {
      const userInstructions = extractCopilotGlobalInstructions()
      if (
        userInstructions &&
        !seenFilePaths.has(userInstructions.path) &&
        hasFileChangedForSession(sessionId, userInstructions)
      ) {
        allRegularFiles.push(userInstructions)
      }
    }

    if (allRegularFiles.length === 0 && allSkillGroups.length === 0) {
      return true
    }

    // Sanitize + zip via worker (off extension host main thread)
    const { files: processedFiles, skills: processedSkills } =
      await getContextFileWorker().process(allRegularFiles, allSkillGroups)

    if (processedFiles.length === 0 && processedSkills.length === 0) {
      return true
    }

    const client = await createGQLClient()
    const uploadUrlResult = await client.getTracyRawDataUploadUrl()
    const { url, uploadFieldsJSON, keyPrefix } =
      uploadUrlResult.getTracyRawDataUploadUrl
    if (!url || !uploadFieldsJSON || !keyPrefix) {
      logger.error(
        { sessionId },
        'Failed to get S3 upload URL for context files'
      )
      return false
    }

    const repo = await getNormalizedRepo(workspaceFolders[0].uri.fsPath)
    const config = getConfig()

    const pipelineResult = await runContextFileUploadPipeline({
      processedFiles,
      processedSkills,
      sessionId,
      platform: platformEnum,
      url,
      uploadFieldsJSON,
      keyPrefix,
      repositoryUrl: repo?.gitRepoUrl ?? undefined,
      clientVersion: config.extensionVersion,
      submitRecords: uploadTracyRecords,
      onFileError: (name, err) =>
        logger.warn(
          { err, name, sessionId },
          'Failed to upload context file to S3'
        ),
      onSkillError: (name, err) =>
        logger.warn(
          { err, name, sessionId },
          'Failed to upload skill zip to S3'
        ),
    })

    if (pipelineResult === null) {
      logger.error(
        { sessionId },
        'Malformed uploadFieldsJSON for context files'
      )
      return false
    }

    if (pipelineResult.fileCount > 0 || pipelineResult.skillCount > 0) {
      logger.info(
        {
          sessionId,
          platform,
          fileCount: pipelineResult.fileCount,
          skillCount: pipelineResult.skillCount,
        },
        'Uploaded context files and skills for session'
      )
    }
    return true
  } catch (err) {
    logger.error(
      { err, sessionId, platform },
      'Failed to scan/upload context files (non-critical)'
    )
    return false
  }
}
