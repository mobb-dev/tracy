import {
  AiBlameInferenceType,
  AnalyzeCommitForExtensionAiBlameMutation,
  AnalyzeCommitForExtensionAiBlameMutationVariables,
  Blame_Ai_Analysis_Request_State_Enum,
  GetAiBlameAttributionPromptQueryVariables,
  GetPromptSummaryQueryVariables,
  GetTracyDiffUploadUrlMutationVariables,
  Status,
  StreamBlameAiAnalysisRequestsDocument,
  StreamCommitBlameRequestsDocument,
} from '../mobbdev_src/features/analysis/scm/generates/client_generates'
import {
  GitService,
  LocalCommitData,
} from '../mobbdev_src/features/analysis/scm/services/GitService'
import { uploadFile } from '../mobbdev_src/features/analysis/upload-file'
import { configStore } from '../mobbdev_src/utils/ConfigStoreService'
import { subscribeToBlameRequests } from '../mobbdev_src/utils/subscribe/subscribe'
import { httpToWsUrl } from '../mobbdev_src/utils/url'
import { getConfig } from '../shared/config'
import {
  createGQLClient,
  invalidateOnAuthError,
} from '../shared/gqlClientFactory'
import { logger } from '../shared/logger'

export type AIBlameAttribution = {
  id: string
  aiBlameCommitId: string
  aiBlameInferenceId: string
  filePath: string
  lineNumber: number
  model: string
  toolName: string
  commitSha: string
  type: AiBlameInferenceType
  authorName?: string
  authorEmail?: string
  authorTime?: number
}

export type BackAndForthLevel = {
  level: number
  justification: string
}

export type PromptSummary = {
  goal: string
  developersPlan: string[]
  aiImplementationDetails: string[]
  developersPushbacks: string[]
  importantInstructionsAndDecisions: string[]
  backAndForthLevel: BackAndForthLevel
  appliedSkills: string[]
  mcpCalls: Array<{ mcpServer: string; mcpTool: string; callCount: number }>
}

export type AIBlameAttributionList = AIBlameAttribution[]

// Simple size-capped cache using Map (preserves insertion order for eviction)
const MAX_ATTRIBUTION_CACHE_SIZE = 200
const MAX_PROMPT_CACHE_SIZE = 50
const MAX_RESOLVE_ITERATIONS = 10
const SUBSCRIPTION_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

type ProcessAIBlameFinalResult = Extract<
  NonNullable<
    AnalyzeCommitForExtensionAiBlameMutation['analyzeCommitForAIBlame']
  >,
  { __typename: 'ProcessAIBlameFinalResult' }
>

function mapAttributions(
  response: ProcessAIBlameFinalResult
): AIBlameAttributionList {
  return response.attributions.map((attr) => ({
    id: attr.id,
    aiBlameCommitId: attr.aiBlameCommitId,
    aiBlameInferenceId: attr.aiBlameInferenceId,
    filePath: attr.filePath,
    lineNumber: attr.lineNumber,
    model: attr.model ?? 'unknown-model',
    toolName: attr.toolName ?? 'unknown-tool',
    commitSha: attr.commitSha,
    type: attr.inferenceType,
  }))
}

// commitSha -> repo-relative filePath -> lineNumber -> attribution
type FileAttributionIndex = Map<number, AIBlameAttribution>
type CommitAttributionIndex = Map<string, FileAttributionIndex>

export class AIBlameCache {
  private attributionCache = new Map<string, CommitAttributionIndex>()
  private promptCache = new Map<string, string>()
  private promptSummaryCache = new Map<string, PromptSummary>()
  private pending: Record<string, Promise<AIBlameAttributionList | null>> = {}
  private gitService: GitService | null = null

  constructor(
    private repoUrl: string,
    private organizationId: string,
    private gitRoot?: string
  ) {
    if (gitRoot) {
      this.gitService = new GitService(gitRoot)
    }
  }

  // Strips gitRoot prefix and normalizes separators to produce a repo-relative
  // POSIX path that matches what the server stores in attribution.filePath.
  // Falls back to a plain POSIX-normalized path when gitRoot is unavailable.
  //
  // Windows-specific: the incoming filePath (from `document.uri.fsPath`) is
  // typically lowercase-drive + backslashes (e.g. `c:\Users\x\repo\foo.ts`),
  // while this.gitRoot (from git CLI) is typically uppercase-drive + forward
  // slashes (e.g. `C:/Users/x/repo`). After converting both to POSIX
  // separators we still need a case-insensitive prefix check on Windows, or
  // every attribution lookup silently returns the full absolute path and
  // misses the attribution index.
  private toRepoRelativePath(filePath: string): string {
    const posix = filePath.replace(/\\/g, '/')
    if (!this.gitRoot) {
      return posix
    }
    const root = this.gitRoot.replace(/\\/g, '/').replace(/\/$/, '')
    const prefix = `${root}/`
    const caseInsensitive = process.platform === 'win32'
    const matches = caseInsensitive
      ? posix.toLowerCase().startsWith(prefix.toLowerCase())
      : posix.startsWith(prefix)
    if (matches) {
      return posix.slice(prefix.length)
    }
    return posix
  }

  private buildCommitAttributionIndex(
    attributions: AIBlameAttributionList
  ): CommitAttributionIndex {
    const index = new Map<string, FileAttributionIndex>()
    for (const attr of attributions) {
      const normalizedPath = attr.filePath.replace(/\\/g, '/')
      let fileIndex = index.get(normalizedPath)
      if (!fileIndex) {
        fileIndex = new Map()
        index.set(normalizedPath, fileIndex)
      }
      fileIndex.set(attr.lineNumber, attr)
    }
    return index
  }

  private async ensureCommitLoaded(commitSha: string): Promise<void> {
    if (this.attributionCache.has(commitSha)) {
      return
    }

    if (commitSha in this.pending) {
      await this.pending[commitSha]
      return
    }

    const promise = (async (): Promise<AIBlameAttributionList | null> => {
      try {
        const result = await this.analyzeCommit(commitSha)
        if (result) {
          this.setCached(
            this.attributionCache,
            commitSha,
            this.buildCommitAttributionIndex(result),
            MAX_ATTRIBUTION_CACHE_SIZE
          )
        }
        return result
      } catch (error) {
        logger.error(
          { error, commitSha },
          `AIBlameCache: Failed to analyze commit ${commitSha}`
        )
        return null
      } finally {
        delete this.pending[commitSha]
      }
    })()

    this.pending[commitSha] = promise
    await promise
  }

  async getAIBlameInfoLine(
    commitSha: string,
    filePath: string,
    lineNumber: number
  ): Promise<AIBlameAttribution | null> {
    // Trigger data loading (handles caching, pending dedup, and error handling)
    await this.ensureCommitLoaded(commitSha)

    const commitIndex = this.attributionCache.get(commitSha)
    if (!commitIndex) {
      return null
    }

    // Strip gitRoot to get a repo-relative path that matches server-stored paths,
    // enabling a direct O(1) map lookup instead of suffix-matching iteration.
    const relPath = this.toRepoRelativePath(filePath)
    return commitIndex.get(relPath)?.get(lineNumber) ?? null
  }

  async getAIBlamePrompt(attributionId: string): Promise<string | null> {
    // Return from cache if present
    if (this.promptCache.has(attributionId)) {
      return this.promptCache.get(attributionId)!
    }

    try {
      const prompt = await GetAiBlamePrompt(attributionId)
      if (prompt) {
        this.setCached(
          this.promptCache,
          attributionId,
          prompt,
          MAX_PROMPT_CACHE_SIZE
        )
      }
      return prompt
    } catch (error) {
      logger.error(
        { error, attributionId },
        `AIBlameCache: Failed to get prompt for attribution ${attributionId}`
      )
      return null
    }
  }

  async getAIBlamePromptSummary(
    attributionId: string
  ): Promise<PromptSummary | null> {
    // Return from cache if present
    if (this.promptSummaryCache.has(attributionId)) {
      return this.promptSummaryCache.get(attributionId)!
    }

    try {
      const MAX_RETRIES = 40
      const RETRY_DELAY_MS = 3000

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const result = await GetAiBlamePromptSummary(attributionId)

        if (result === 'PROCESSING') {
          // Summary is being generated, wait and retry
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
          continue
        }

        if (result) {
          this.setCached(
            this.promptSummaryCache,
            attributionId,
            result,
            MAX_PROMPT_CACHE_SIZE
          )
          return result
        }

        return null
      }

      logger.warn(
        { attributionId },
        `AIBlameCache: Prompt summary still processing after ${MAX_RETRIES} retries`
      )
      return null
    } catch (error) {
      logger.error(
        { error, attributionId },
        `AIBlameCache: Failed to get prompt for attribution ${attributionId}`
      )
      return null
    }
  }

  // Set a value in the cache, evicting oldest entries if needed
  private setCached<T>(
    cache: Map<string, T>,
    key: string,
    value: T,
    maxSize: number
  ): void {
    // Evict oldest entries if cache is full
    while (cache.size >= maxSize) {
      const oldestKey = cache.keys().next().value
      if (oldestKey) {
        cache.delete(oldestKey)
      }
    }
    cache.set(key, value)
  }

  private waitForBlameCompletion(
    requestIds: string[],
    commitBlameRequestIds: string[],
    commitSha: string
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      let unsubscribe: (() => void) | undefined

      const finalize = (error?: Error) => {
        if (settled) {
          return
        }
        settled = true
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = undefined
        }
        try {
          unsubscribe?.()
          unsubscribe = undefined
        } catch (e) {
          logger.error(
            { error: e, commitSha },
            `AIBlameCache: Error while unsubscribing for commit ${commitSha}`
          )
        }
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }

      const apiToken = configStore.get('apiToken') as string

      unsubscribe = subscribeToBlameRequests({
        blameAiRequestIds: requestIds,
        commitBlameRequestIds,
        config: {
          auth: {
            mobbApiKey: apiToken,
          },
          graphqlEndpoint: httpToWsUrl(getConfig().apiUrl),
          websocketImpl: WebSocket,
        },
        callbacks: {
          onSuccess: () => {
            logger.info(
              `AIBlameCache: Analysis completed for commit ${commitSha}`
            )
            finalize()
          },
          onError: (error: string) => {
            logger.error(
              `AIBlameCache: Subscription error for commit ${commitSha}: ${error}`
            )
            finalize(new Error(error))
          },
          onBlameAiUpdate: (requests) => {
            logger.info(
              `AIBlameCache: AI blame update for commit ${commitSha}: ${requests.length} requests, states: ${requests.map((r) => r.state).join(', ')}`
            )
          },
          onCommitBlameUpdate: (requests) => {
            logger.info(
              `AIBlameCache: Commit blame update for commit ${commitSha}: ${requests.length} requests, states: ${requests.map((r) => r.state).join(', ')}`
            )
          },
        },
        blameAiDocument: StreamBlameAiAnalysisRequestsDocument,
        commitBlameDocument: StreamCommitBlameRequestsDocument,
        requestedState: Blame_Ai_Analysis_Request_State_Enum.Requested,
        errorState: Blame_Ai_Analysis_Request_State_Enum.Error,
      })

      timeoutId = setTimeout(() => {
        logger.warn(
          `AIBlameCache: Subscription timeout for commit ${commitSha}`
        )
        finalize(new Error('Subscription timeout'))
      }, SUBSCRIPTION_TIMEOUT_MS)
    })
  }

  private async resolveBlameResult(
    commitSha: string,
    localCommitData?: LocalCommitData
  ): Promise<AIBlameAttributionList | null> {
    for (let i = 0; i < MAX_RESOLVE_ITERATIONS; i++) {
      const result = await analyzeCommitForExtensionAIBlameWrapper(
        commitSha,
        this.organizationId,
        this.repoUrl,
        localCommitData
      )

      const response = result.analyzeCommitForAIBlame

      if (!response) {
        logger.error(`AIBlameCache: No response for commit ${commitSha}`)
        return null
      }

      if (response.__typename === 'ProcessAIBlameErrorResult') {
        logger.error(
          `AIBlameCache: Error analyzing commit ${commitSha}: ${response.error}`
        )
        return null
      }

      if (response.__typename === 'ProcessAIBlameFinalResult') {
        const attributions = mapAttributions(response)
        logger.info(
          `AIBlameCache: Final result for commit ${commitSha}, attributions=${attributions.length}`
        )
        return attributions
      }

      if (response.__typename === 'ProcessAIBlameRequestedResult') {
        logger.info(
          `AIBlameCache: Analysis for commit ${commitSha} is pending (iteration=${i + 1}, status=${response.status}, requestIds=${response.requestIds.join(',')}, commitBlameRequestIds=${response.commitBlameRequestIds.join(',')}) - subscribing for updates`
        )

        // Ensure we have a valid auth client for subscription
        await createGQLClient()

        try {
          await this.waitForBlameCompletion(
            response.requestIds,
            response.commitBlameRequestIds,
            commitSha
          )
        } catch (error) {
          logger.error(
            { error, commitSha },
            `AIBlameCache: Subscription failed for commit ${commitSha}`
          )
          return null
        }

        // Loop continues — re-call mutation to check the new state
      }
    }

    logger.error(
      `AIBlameCache: Max iterations (${MAX_RESOLVE_ITERATIONS}) reached for commit ${commitSha}`
    )
    return null
  }

  private async analyzeCommit(
    commitSha: string
  ): Promise<AIBlameAttributionList | null> {
    if (!this.organizationId || !this.repoUrl) {
      logger.error('AIBlameCache: organizationId or repoUrl not set')
      return null
    }

    logger.debug(`AIBlameCache: Analyzing commit ${commitSha}`)

    try {
      // Try to get local commit data first (allows skipping SCM token requirement)
      let localCommitData: LocalCommitData | undefined

      if (this.gitService) {
        try {
          const localData = await this.gitService.getLocalCommitData(commitSha)
          if (localData) {
            localCommitData = localData
            logger.debug(
              `AIBlameCache: Using local commit data for ${commitSha} (diff size: ${localData.diff.length} bytes)`
            )
          }
        } catch (error) {
          logger.warn(
            { error, commitSha },
            'AIBlameCache: Failed to get local commit data, will use server-side fetch'
          )
        }
      }

      return await this.resolveBlameResult(commitSha, localCommitData)
    } catch (error) {
      invalidateOnAuthError(error)
      logger.error(
        { error, commitSha },
        `AIBlameCache: Error analyzing commit ${commitSha}`
      )
    }

    return null
  }

  clearCommit(commitSha: string): void {
    this.attributionCache.delete(commitSha)
    delete this.pending[commitSha]
  }

  clearAll(): void {
    this.attributionCache.clear()
    this.pending = {}
    this.promptCache.clear()
    this.promptSummaryCache.clear()
  }

  dispose(): void {
    this.clearAll()
  }
}

export async function analyzeCommitForExtensionAIBlameWrapper(
  commitSha: string,
  organizationId: string,
  repositoryURL: string,
  localCommitData?: LocalCommitData
): Promise<AnalyzeCommitForExtensionAiBlameMutation> {
  try {
    logger.debug('Authenticating for AI Blame commit analysis')
    const gqlClient = await createGQLClient()

    logger.debug(
      {
        commitSha,
        organizationId,
        repositoryURL,
        hasLocalData: !!localCommitData,
      },
      'Analyzing commit for AI Blame'
    )

    // If we have a local diff, upload it to S3 first
    if (localCommitData?.diff) {
      try {
        const uploadUrlVariables: GetTracyDiffUploadUrlMutationVariables = {
          commitSha,
        }
        const uploadUrlResult =
          await gqlClient.getTracyDiffUploadUrl(uploadUrlVariables)

        if (
          uploadUrlResult.getTracyDiffUploadUrl.status === Status.Ok &&
          uploadUrlResult.getTracyDiffUploadUrl.uploadInfo
        ) {
          const { url, uploadFieldsJSON, uploadKey } =
            uploadUrlResult.getTracyDiffUploadUrl.uploadInfo

          await uploadFile({
            file: Buffer.from(localCommitData.diff),
            url,
            uploadKey,
            uploadFields: JSON.parse(uploadFieldsJSON),
          })
          logger.debug({ commitSha }, 'Successfully uploaded diff to S3')
        } else {
          logger.warn(
            {
              commitSha,
              error: uploadUrlResult.getTracyDiffUploadUrl.error,
            },
            'Failed to get upload URL, server will attempt to fetch diff from SCM provider'
          )
        }
      } catch (uploadError) {
        logger.warn(
          { commitSha, error: uploadError },
          'Failed to upload diff to S3, server will attempt to fetch diff from SCM provider'
        )
      }
    }

    const variables: AnalyzeCommitForExtensionAiBlameMutationVariables = {
      commitSha,
      organizationId,
      repositoryURL,
      // Note: commitDiff is no longer sent - backend reads from S3
      commitTimestamp: localCommitData?.timestamp.toISOString(),
      commitAuthor: localCommitData?.author,
      commitCommitter: localCommitData?.committer,
      commitCoAuthors: localCommitData?.coAuthors,
    }

    const result = await gqlClient.analyzeCommitForExtensionAIBlame(variables)
    logger.debug({ result }, 'AI Blame commit analysis result')

    return result
  } catch (err) {
    invalidateOnAuthError(err)
    logger.error({ error: err }, 'Error during AI Blame commit analysis')
    throw err
  }
}

/**
 * Loads CHAT prompt / conversation JSON for the Tracy panel.
 *
 * Conversation text always comes from the API (`getAIBlameInferenceData.conversationMessages`).
 * The extension does not download presigned S3 URLs; Tracy vs legacy is handled on the server.
 */
export async function GetAiBlamePrompt(
  attributionId: string
): Promise<string | null> {
  try {
    const gqlClient = await createGQLClient()
    const variables: GetAiBlameAttributionPromptQueryVariables = {
      aiBlameAttributionId: attributionId,
    }
    const result = await gqlClient.getAIBlameAttributionPrompt(variables)
    const { conversationMessages } = result.getAIBlameInferenceData

    if (conversationMessages) {
      logger.info(
        `Using ${conversationMessages.length} conversation messages from backend for attribution ${attributionId}`
      )
      return JSON.stringify(conversationMessages)
    }

    logger.warn(
      `No conversation messages from API for attribution ${attributionId}`
    )
    return null
  } catch (err) {
    invalidateOnAuthError(err)
    logger.error({ error: err }, 'Error during GetAiBlameAttributionPrompt')
    return null
  }
}

/**
 * Polls `getPromptSummary` until the server has a cached summary or errors.
 */
export async function GetAiBlamePromptSummary(
  attributionId: string
): Promise<PromptSummary | 'PROCESSING' | null> {
  try {
    const gqlClient = await createGQLClient()
    const variables: GetPromptSummaryQueryVariables = {
      aiBlameAttributionId: attributionId,
    }
    const result = await gqlClient.getAIBlameAttributionPromptSummary(variables)

    if (!result) {
      logger.error(
        `AIBlameCache: No response for attributionId ${attributionId}`
      )
      return null
    }
    const response = result.getPromptSummary
    if (response.__typename === 'PromptSummaryError') {
      logger.error(
        `AIBlameCache: Error getting prompt summary ${attributionId}: ${response.error}`
      )
      return null
    }

    if (response.__typename === 'PromptSummaryProcessing') {
      return 'PROCESSING'
    }

    if (response.__typename === 'PromptSummarySuccess') {
      if (response.status == Status.Ok) {
        return {
          ...response.summary,
          appliedSkills: response.summary.appliedSkills ?? [],
          mcpCalls: response.summary.mcpCalls ?? [],
        }
      }
    }
  } catch (err) {
    invalidateOnAuthError(err)
    logger.error(
      { error: err },
      'Error during GetAiBlameAttributionPromptSummary'
    )
  }
  return null
}
