import {
  AiBlameInferenceType,
  AnalyzeCommitForExtensionAiBlameMutation,
  AnalyzeCommitForExtensionAiBlameMutationVariables,
  Blame_Ai_Analysis_Request_State_Enum,
  GetAiBlameAttributionPromptQueryVariables,
  StreamBlameAiAnalysisRequestsDocument,
} from '../mobbdev_src/features/analysis/scm/generates/client_generates'
import { configStore } from '../mobbdev_src/utils/ConfigStoreService'
import { subscribeToBlameAiAnalysisRequests } from '../mobbdev_src/utils/subscribe/subscribe'
import { getConfig } from '../shared/config'
import { createGQLClient } from '../shared/gqlClientFactory'
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
}

export type AIBlameAttributionList = AIBlameAttribution[]

// Simple size-capped cache using Map (preserves insertion order for eviction)
const MAX_ATTRIBUTION_CACHE_SIZE = 200
const MAX_PROMPT_CACHE_SIZE = 50

export class AIBlameCache {
  private attributionCache = new Map<string, AIBlameAttributionList>()
  private promptCache = new Map<string, string>()
  private pending: Record<string, Promise<AIBlameAttributionList | null>> = {}

  constructor(
    private repoUrl: string,
    private organizationId: string
  ) {}

  private matchesFilePath(
    filePath: string,
    attributionFilePath: string
  ): boolean {
    // Normalize Windows paths to POSIX-style separators for comparison.
    const full = filePath.replace(/\\/g, '/')
    const suffix = attributionFilePath.replace(/\\/g, '/')

    if (full === suffix) {
      return true
    }

    // Ensure the suffix matches a full path segment boundary.
    // Example: suffix "test.ts" should match "/repo/test.ts" but not "/repo/mytest.ts".
    const idx = full.lastIndexOf(suffix)
    if (idx === -1) {
      return false
    }
    if (idx + suffix.length !== full.length) {
      return false
    }
    if (idx === 0) {
      return true
    }
    return full[idx - 1] === '/'
  }

  async getAIBlameInfoLine(
    commitSha: string,
    filePath: string,
    lineNumber: number
  ): Promise<AIBlameAttribution | null> {
    const aiBlameInfo = await this.getAIBlameInfo(commitSha)
    if (aiBlameInfo) {
      for (const attr of aiBlameInfo) {
        if (attr.lineNumber === lineNumber) {
          if (this.matchesFilePath(filePath, attr.filePath)) {
            return attr
          }
        }
      }
    }
    return null
  }

  async getAIBlameInfo(
    commitSha: string
  ): Promise<AIBlameAttributionList | null> {
    // 1. Return from cache if present
    if (this.attributionCache.has(commitSha)) {
      return this.attributionCache.get(commitSha)!
    }

    // 2. If we already have an in-flight request, just await it
    if (commitSha in this.pending) {
      return this.pending[commitSha]
    }

    // 3. Start new analysis with error handling built into the Promise
    // This ensures both first and concurrent callers get consistent error behavior
    const promise = (async (): Promise<AIBlameAttributionList | null> => {
      try {
        const result = await this.analyzeCommit(commitSha)
        if (result) {
          this.setCached(
            this.attributionCache,
            commitSha,
            result,
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
    return promise
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

  private async analyzeCommit(
    commitSha: string
  ): Promise<AIBlameAttributionList | null> {
    if (!this.organizationId || !this.repoUrl) {
      logger.error('AIBlameCache: organizationId or repoUrl not set')
      return null
    }

    logger.info(`AIBlameCache: Analyzing commit ${commitSha}`)

    try {
      // First, initiate the analysis
      const result = await analyzeCommitForExtensionAIBlameWrapper(
        commitSha,
        this.organizationId,
        this.repoUrl
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
        // Analysis is already complete - return results immediately
        const attributions: AIBlameAttributionList = response.attributions.map(
          (attr) => {
            return {
              id: attr.id,
              aiBlameCommitId: attr.aiBlameCommitId,
              aiBlameInferenceId: attr.aiBlameInferenceId,
              filePath: attr.filePath,
              lineNumber: attr.lineNumber,
              model: attr.model ?? 'unknown-model',
              toolName: attr.toolName ?? 'unknown-tool',
              commitSha: attr.commitSha,
              type: attr.inferenceType,
            }
          }
        )

        logger.info(
          `AIBlameCache: Final result for commit ${commitSha}, attributions=${attributions.length}`
        )
        return attributions
      }

      if (response.__typename === 'ProcessAIBlameRequestedResult') {
        // Analysis is pending - use subscription to wait for completion
        logger.info(
          `AIBlameCache: Analysis for commit ${commitSha} is pending (status=${response.status}, requestIds=${response.requestIds.join(
            ','
          )}) - subscribing for updates`
        )

        // Get authentication client for subscription first
        await createGQLClient()

        // Get the API token from config store (guaranteed to be valid after successful auth)
        const apiToken = configStore.get('apiToken') as string

        return new Promise<AIBlameAttributionList | null>((resolve) => {
          let settled = false
          let timeoutId: ReturnType<typeof setTimeout> | undefined
          let unsubscribe: (() => void) | undefined

          const finalize = (value: AIBlameAttributionList | null) => {
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
              // Prevent double-unsubscribe and satisfy prefer-const by making it mutable.
              unsubscribe = undefined
            } catch (e) {
              // Best-effort cleanup. Avoid throwing from cleanup path.
              logger.error(
                { error: e, commitSha },
                `AIBlameCache: Error while unsubscribing for commit ${commitSha}`
              )
            }
            resolve(value)
          }

          unsubscribe = subscribeToBlameAiAnalysisRequests({
            requestIds: response.requestIds,
            config: {
              auth: {
                mobbApiKey: apiToken,
              },
              graphqlEndpoint: getConfig().apiUrl.replace('http', 'ws'),
              websocketImpl: WebSocket,
            },
            callbacks: {
              onSuccess: async () => {
                logger.info(
                  `AIBlameCache: Analysis completed for commit ${commitSha}`
                )

                // Fetch the final results
                try {
                  const finalResult =
                    await analyzeCommitForExtensionAIBlameWrapper(
                      commitSha,
                      this.organizationId,
                      this.repoUrl
                    )

                  const finalResponse = finalResult.analyzeCommitForAIBlame

                  if (
                    finalResponse?.__typename === 'ProcessAIBlameFinalResult'
                  ) {
                    const attributions: AIBlameAttributionList =
                      finalResponse.attributions.map((attr) => ({
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

                    logger.info(
                      `AIBlameCache: Final result for commit ${commitSha}, attributions=${attributions.length}`
                    )
                    finalize(attributions)
                  } else {
                    logger.error(
                      `AIBlameCache: Unexpected response type after completion: ${finalResponse?.__typename}`
                    )
                    finalize(null)
                  }
                } catch (error) {
                  logger.error(
                    { error, commitSha },
                    `AIBlameCache: Error fetching final results for commit ${commitSha}`
                  )
                  finalize(null)
                }
              },
              onError: (error: string) => {
                logger.error(
                  `AIBlameCache: Subscription error for commit ${commitSha}: ${error}`
                )
                finalize(null)
              },
              onUpdate: (requests: Array<{ state: string }>) => {
                logger.info(
                  `AIBlameCache: Subscription update for commit ${commitSha}: ${requests.length} requests, states: ${requests.map((r) => r.state).join(', ')}`
                )
              },
            },
            blameAiDocument: StreamBlameAiAnalysisRequestsDocument,
            commitBlameDocument: StreamBlameAiAnalysisRequestsDocument, // Same document since only using AI analysis
            requestedState: Blame_Ai_Analysis_Request_State_Enum.Requested,
            errorState: Blame_Ai_Analysis_Request_State_Enum.Error,
          })

          // Set up a timeout to prevent infinite waiting
          timeoutId = setTimeout(
            () => {
              logger.warn(
                `AIBlameCache: Subscription timeout for commit ${commitSha}`
              )
              finalize(null)
            },
            5 * 60 * 1000
          ) // 5 minutes timeout
        })
      }
    } catch (error) {
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
  }

  dispose(): void {
    this.clearAll()
  }
}

export async function analyzeCommitForExtensionAIBlameWrapper(
  commitSha: string,
  organizationId: string,
  repositoryURL: string
): Promise<AnalyzeCommitForExtensionAiBlameMutation> {
  try {
    logger.info('Authenticating for AI Blame commit analysis')
    const gqlClient = await createGQLClient()

    logger.info(
      `Analyzing commit for AI Blame: sha=${commitSha}, org=${organizationId}, repo=${repositoryURL}`
    )

    const variables: AnalyzeCommitForExtensionAiBlameMutationVariables = {
      commitSha,
      organizationId,
      repositoryURL,
    }

    const result = await gqlClient.analyzeCommitForExtensionAIBlame(variables)
    logger.info({ result }, 'AI Blame commit analysis result')

    return result
  } catch (err) {
    logger.error({ error: err }, 'Error during AI Blame commit analysis')
    throw err
  }
}

export async function GetAiBlamePrompt(
  attributionId: string
): Promise<string | null> {
  try {
    const gqlClient = await createGQLClient()
    const variables: GetAiBlameAttributionPromptQueryVariables = {
      aiBlameAttributionId: attributionId,
    }
    const result = await gqlClient.getAIBlameAttributionPrompt(variables)
    const { promptUrl } = result.getAIBlameInferenceData

    if (!promptUrl) {
      logger.warn(`No prompt URL found for attribution ${attributionId}`)
      return null
    }

    // Download the prompt content from the URL
    logger.info(`Downloading prompt from URL: ${promptUrl}`)
    const response = await fetch(promptUrl)

    if (!response.ok) {
      logger.error(
        `Failed to download prompt: ${response.status} ${response.statusText}`
      )
      return null
    }

    const promptContent = await response.text()
    logger.info(
      `Successfully downloaded prompt content (${promptContent.length} characters)`
    )

    return promptContent
  } catch (err) {
    logger.error({ error: err }, 'Error during GetAiBlameAttributionPrompt')
    return null
  }
}
