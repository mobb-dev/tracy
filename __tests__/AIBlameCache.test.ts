import { afterEach, describe, expect, it, vi } from 'vitest'

// Mock vscode (required by config.ts)
vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      inspect: vi.fn(() => ({
        workspaceValue: undefined,
        globalValue: undefined,
      })),
    })),
  },
}))

// Mock GraphQL client and logger
vi.mock('../src/mobbdev_src/commands/handleMobbLogin', () => ({
  getAuthenticatedGQLClient: vi.fn(),
}))

vi.mock('../src/shared/gqlClientFactory', () => ({
  createGQLClient: vi.fn(),
}))

vi.mock('../src/shared/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// Mock fetch for prompt fetching
global.fetch = vi.fn()

describe('AIBlameCache', () => {
  afterEach(() => {
    vi.resetAllMocks()
    vi.clearAllTimers()
  })

  describe('matchesFilePath', () => {
    it('matches exact file paths', async () => {
      const { AIBlameCache } = await import('../src/ui/AIBlameCache')
      const cache = new AIBlameCache('repo-url', 'org-id')

      // Use reflection to access private method for testing
      const matchesFilePath = (cache as any).matchesFilePath.bind(cache)

      expect(matchesFilePath('/repo/src/file.ts', '/repo/src/file.ts')).toBe(
        true
      )
      expect(matchesFilePath('file.ts', 'file.ts')).toBe(true)
    })

    it('matches suffix paths at directory boundaries', async () => {
      const { AIBlameCache } = await import('../src/ui/AIBlameCache')
      const cache = new AIBlameCache('repo-url', 'org-id')

      const matchesFilePath = (cache as any).matchesFilePath.bind(cache)

      expect(matchesFilePath('/repo/src/file.ts', 'src/file.ts')).toBe(true)
      expect(matchesFilePath('/repo/src/file.ts', 'file.ts')).toBe(true)
      expect(
        matchesFilePath(
          '/home/user/repo/src/components/Button.tsx',
          'components/Button.tsx'
        )
      ).toBe(true)
    })

    it('does not match partial file names', async () => {
      const { AIBlameCache } = await import('../src/ui/AIBlameCache')
      const cache = new AIBlameCache('repo-url', 'org-id')

      const matchesFilePath = (cache as any).matchesFilePath.bind(cache)

      expect(matchesFilePath('/repo/src/mytest.ts', 'test.ts')).toBe(false)
      expect(matchesFilePath('/repo/src/testfile.ts', 'test.ts')).toBe(false)
    })

    it('normalizes Windows and POSIX path separators', async () => {
      const { AIBlameCache } = await import('../src/ui/AIBlameCache')
      const cache = new AIBlameCache('repo-url', 'org-id')

      const matchesFilePath = (cache as any).matchesFilePath.bind(cache)

      expect(matchesFilePath('C:\\repo\\src\\file.ts', 'src/file.ts')).toBe(
        true
      )
      expect(matchesFilePath('/repo/src/file.ts', 'src\\file.ts')).toBe(true)
      expect(matchesFilePath('C:\\repo\\src\\file.ts', 'src\\file.ts')).toBe(
        true
      )
    })
  })

  describe('cache management', () => {
    it('evicts oldest entries when attribution cache exceeds 200 items', async () => {
      const { AIBlameCache } = await import('../src/ui/AIBlameCache')
      const cache = new AIBlameCache('repo-url', 'org-id')

      // Fill cache with 200 items
      const attributionCache = (cache as any).attributionCache as Map<
        string,
        any
      >
      for (let i = 0; i < 200; i++) {
        attributionCache.set(`commit-${i}`, [{ id: `attr-${i}` }])
      }

      expect(attributionCache.size).toBe(200)
      expect(attributionCache.has('commit-0')).toBe(true)

      // Add one more item to trigger eviction
      attributionCache.set('commit-200', [{ id: 'attr-200' }])

      // Use setCached method to trigger eviction logic
      const setCached = (cache as any).setCached.bind(cache)
      setCached(attributionCache, 'commit-201', [{ id: 'attr-201' }], 200)

      expect(attributionCache.size).toBe(200)
      expect(attributionCache.has('commit-0')).toBe(false) // Oldest should be evicted
      expect(attributionCache.has('commit-201')).toBe(true) // Newest should exist
    })

    it('evicts oldest entries when prompt cache exceeds 50 items', async () => {
      const { AIBlameCache } = await import('../src/ui/AIBlameCache')
      const cache = new AIBlameCache('repo-url', 'org-id')

      const promptCache = (cache as any).promptCache as Map<string, string>
      for (let i = 0; i < 50; i++) {
        promptCache.set(`prompt-${i}`, `content-${i}`)
      }

      expect(promptCache.size).toBe(50)
      expect(promptCache.has('prompt-0')).toBe(true)

      // Trigger eviction through setCached
      const setCached = (cache as any).setCached.bind(cache)
      setCached(promptCache, 'prompt-50', 'content-50', 50)

      expect(promptCache.size).toBe(50)
      expect(promptCache.has('prompt-0')).toBe(false)
      expect(promptCache.has('prompt-50')).toBe(true)
    })
  })

  describe('concurrent request handling', () => {
    it('deduplicates concurrent requests for same commit', async () => {
      const mockAnalyzeResult = {
        analyzeCommitForAIBlame: {
          __typename: 'ProcessAIBlameFinalResult',
          attributions: [
            {
              id: 'attr-1',
              aiBlameCommitId: 'commit-1',
              aiBlameInferenceId: 'inf-1',
              filePath: 'src/file.ts',
              lineNumber: 10,
              model: 'gpt-4',
              toolName: 'cursor',
              commitSha: 'abc123',
            },
          ],
        },
      }

      const mockGqlClient = {
        analyzeCommitForExtensionAIBlame: vi
          .fn()
          .mockResolvedValue(mockAnalyzeResult),
        getAIBlameInference: vi
          .fn()
          .mockResolvedValue({ ai_blame_inference: [] }),
      }

      const { getAuthenticatedGQLClient } = await import(
        '../src/mobbdev_src/commands/handleMobbLogin'
      )
      ;(getAuthenticatedGQLClient as any).mockResolvedValue(mockGqlClient)

      const { createGQLClient } = await import('../src/shared/gqlClientFactory')
      ;(createGQLClient as any).mockResolvedValue(mockGqlClient)

      const { AIBlameCache } = await import('../src/ui/AIBlameCache')
      const cache = new AIBlameCache('repo-url', 'org-id')

      // Start three concurrent requests for same commit
      const promises = [
        cache.getAIBlameInfo('abc123'),
        cache.getAIBlameInfo('abc123'),
        cache.getAIBlameInfo('abc123'),
      ]

      const results = await Promise.all(promises)

      // All should return same result
      expect(results[0]).toEqual(results[1])
      expect(results[1]).toEqual(results[2])

      // But GraphQL client should only be called once
      expect(
        mockGqlClient.analyzeCommitForExtensionAIBlame
      ).toHaveBeenCalledTimes(1)
    })
  })

  describe('error handling', () => {
    it('handles network errors gracefully', async () => {
      const { getAuthenticatedGQLClient } = await import(
        '../src/mobbdev_src/commands/handleMobbLogin'
      )
      ;(getAuthenticatedGQLClient as any).mockRejectedValue(
        new Error('Network error')
      )

      const { AIBlameCache } = await import('../src/ui/AIBlameCache')
      const { logger } = await import('../src/shared/logger')

      const cache = new AIBlameCache('repo-url', 'org-id')

      const result = await cache.getAIBlameInfo('abc123')

      expect(result).toBeNull()
      // Note: the error is logged both in the wrapper and in the cache layer.
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('AIBlameCache: Error analyzing commit abc123'),
        expect.any(Error)
      )
    })

    it('handles missing organization or repo URL', async () => {
      const { AIBlameCache } = await import('../src/ui/AIBlameCache')
      const { logger } = await import('../src/shared/logger')

      const cache = new AIBlameCache('', '') // Empty repo/org

      const result = await cache.getAIBlameInfo('abc123')

      expect(result).toBeNull()
      expect(logger.error).toHaveBeenCalledWith(
        'AIBlameCache: organizationId or repoUrl not set'
      )
    })

    it('handles prompt fetch failures gracefully', async () => {
      ;(global.fetch as any).mockRejectedValue(new Error('Fetch failed'))

      const mockGqlClient = {
        getAIBlameAttributionPrompt: vi.fn().mockResolvedValue({
          getAIBlameInferenceData: {
            promptUrl: 'https://example.com/prompt.json',
          },
        }),
      }

      const { getAuthenticatedGQLClient } = await import(
        '../src/mobbdev_src/commands/handleMobbLogin'
      )
      ;(getAuthenticatedGQLClient as any).mockResolvedValue(mockGqlClient)

      const { AIBlameCache } = await import('../src/ui/AIBlameCache')
      const { logger } = await import('../src/shared/logger')

      const cache = new AIBlameCache('repo-url', 'org-id')

      const result = await cache.getAIBlamePrompt('attr-123')

      expect(result).toBeNull()
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error during GetAiBlameAttributionPrompt'),
        expect.any(Error)
      )
    })
  })
})
