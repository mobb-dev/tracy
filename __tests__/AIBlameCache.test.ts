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
  invalidateOnAuthError: vi.fn(),
}))

vi.mock('../src/shared/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// Mock GitService to prevent real git operations in tests
vi.mock('../src/mobbdev_src/features/analysis/scm/services/GitService', () => ({
  GitService: vi.fn().mockImplementation(() => ({
    getLocalCommitData: vi.fn(),
  })),
}))

// Mock fetch for prompt fetching
global.fetch = vi.fn()

describe('AIBlameCache', () => {
  afterEach(() => {
    vi.resetAllMocks()
    vi.clearAllTimers()
  })

  describe('toRepoRelativePath', () => {
    it('converts absolute paths to repo-relative paths when gitRoot is set', async () => {
      const { AIBlameCache } = await import('../src/ui/AIBlameCache')
      const cache = new AIBlameCache('repo-url', 'org-id', '/Users/dev/repo')

      // Use reflection to access private method for testing
      const toRepoRelativePath = (cache as any).toRepoRelativePath.bind(cache)

      expect(toRepoRelativePath('/Users/dev/repo/src/file.ts')).toBe(
        'src/file.ts'
      )
      expect(
        toRepoRelativePath('/Users/dev/repo/src/components/Button.tsx')
      ).toBe('src/components/Button.tsx')
    })

    it('returns normalized POSIX path when gitRoot is not available', async () => {
      const { AIBlameCache } = await import('../src/ui/AIBlameCache')
      const cache = new AIBlameCache('repo-url', 'org-id') // No gitRoot

      const toRepoRelativePath = (cache as any).toRepoRelativePath.bind(cache)

      expect(toRepoRelativePath('/absolute/path/to/file.ts')).toBe(
        '/absolute/path/to/file.ts'
      )
      expect(toRepoRelativePath('relative/file.ts')).toBe('relative/file.ts')
    })

    it('handles paths that do not start with gitRoot', async () => {
      const { AIBlameCache } = await import('../src/ui/AIBlameCache')
      const cache = new AIBlameCache('repo-url', 'org-id', '/Users/dev/repo')

      const toRepoRelativePath = (cache as any).toRepoRelativePath.bind(cache)

      // Path not under gitRoot should return as-is (normalized)
      expect(toRepoRelativePath('/Users/other/project/file.ts')).toBe(
        '/Users/other/project/file.ts'
      )
    })

    it('normalizes Windows backslashes to forward slashes', async () => {
      const { AIBlameCache } = await import('../src/ui/AIBlameCache')
      const cache = new AIBlameCache('repo-url', 'org-id', 'C:/Users/dev/repo')

      const toRepoRelativePath = (cache as any).toRepoRelativePath.bind(cache)

      expect(toRepoRelativePath('C:\\Users\\dev\\repo\\src\\file.ts')).toBe(
        'src/file.ts'
      )
      expect(toRepoRelativePath('src\\components\\Button.tsx')).toBe(
        'src/components/Button.tsx'
      )
    })

    it('handles gitRoot with trailing slashes correctly', async () => {
      const { AIBlameCache } = await import('../src/ui/AIBlameCache')
      const cache = new AIBlameCache('repo-url', 'org-id', '/Users/dev/repo/')

      const toRepoRelativePath = (cache as any).toRepoRelativePath.bind(cache)

      expect(toRepoRelativePath('/Users/dev/repo/src/file.ts')).toBe(
        'src/file.ts'
      )
    })
  })

  describe('cache management', () => {
    it('evicts oldest entries when attribution cache exceeds 200 items', async () => {
      const { AIBlameCache } = await import('../src/ui/AIBlameCache')
      const cache = new AIBlameCache('repo-url', 'org-id')

      // Fill cache with 200 items - use the proper structure (Map of commitSha -> commitAttributionIndex)
      const attributionCache = (cache as any).attributionCache as Map<
        string,
        Map<string, Map<number, any>>
      >

      for (let i = 0; i < 200; i++) {
        // Create the nested structure: commitSha -> filePath -> lineNumber -> attribution
        const fileIndex = new Map<string, Map<number, any>>()
        const lineIndex = new Map<number, any>()
        lineIndex.set(1, {
          id: `attr-${i}`,
          filePath: 'test.ts',
          lineNumber: 1,
        })
        fileIndex.set('test.ts', lineIndex)
        attributionCache.set(`commit-${i}`, fileIndex)
      }

      expect(attributionCache.size).toBe(200)
      expect(attributionCache.has('commit-0')).toBe(true)

      // Use setCached method to trigger eviction when adding a new item
      const setCached = (cache as any).setCached.bind(cache)
      const newFileIndex = new Map<string, Map<number, any>>()
      const newLineIndex = new Map<number, any>()
      newLineIndex.set(1, {
        id: 'attr-200',
        filePath: 'test.ts',
        lineNumber: 1,
      })
      newFileIndex.set('test.ts', newLineIndex)

      setCached(attributionCache, 'commit-200', newFileIndex, 200)

      expect(attributionCache.size).toBe(200)
      expect(attributionCache.has('commit-0')).toBe(false) // Oldest should be evicted
      expect(attributionCache.has('commit-200')).toBe(true) // Newest should exist
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

  describe('buildCommitAttributionIndex', () => {
    it('builds correct file and line index structure', async () => {
      const { AIBlameCache } = await import('../src/ui/AIBlameCache')
      const cache = new AIBlameCache('repo-url', 'org-id')

      const buildCommitAttributionIndex = (
        cache as any
      ).buildCommitAttributionIndex.bind(cache)

      const attributions = [
        {
          id: 'attr-1',
          filePath: 'src/file.ts',
          lineNumber: 10,
          aiBlameCommitId: 'commit-1',
          aiBlameInferenceId: 'inf-1',
          model: 'gpt-4',
          toolName: 'cursor',
          commitSha: 'abc123',
          type: 'AI_GENERATED',
        },
        {
          id: 'attr-2',
          filePath: 'src/file.ts',
          lineNumber: 20,
          aiBlameCommitId: 'commit-1',
          aiBlameInferenceId: 'inf-2',
          model: 'gpt-4',
          toolName: 'cursor',
          commitSha: 'abc123',
          type: 'AI_GENERATED',
        },
        {
          id: 'attr-3',
          filePath: 'src/other.ts',
          lineNumber: 5,
          aiBlameCommitId: 'commit-1',
          aiBlameInferenceId: 'inf-3',
          model: 'gpt-4',
          toolName: 'cursor',
          commitSha: 'abc123',
          type: 'AI_GENERATED',
        },
      ]

      const index = buildCommitAttributionIndex(attributions)

      // Should have entries for both files
      expect(index.has('src/file.ts')).toBe(true)
      expect(index.has('src/other.ts')).toBe(true)

      // Check line entries for first file
      const fileIndex = index.get('src/file.ts')!
      expect(fileIndex.has(10)).toBe(true)
      expect(fileIndex.has(20)).toBe(true)
      expect(fileIndex.get(10)?.id).toBe('attr-1')
      expect(fileIndex.get(20)?.id).toBe('attr-2')

      // Check line entry for second file
      const otherFileIndex = index.get('src/other.ts')!
      expect(otherFileIndex.has(5)).toBe(true)
      expect(otherFileIndex.get(5)?.id).toBe('attr-3')
    })

    it('normalizes file paths with backslashes', async () => {
      const { AIBlameCache } = await import('../src/ui/AIBlameCache')
      const cache = new AIBlameCache('repo-url', 'org-id')

      const buildCommitAttributionIndex = (
        cache as any
      ).buildCommitAttributionIndex.bind(cache)

      const attributions = [
        {
          id: 'attr-1',
          filePath: 'src\\windows\\file.ts', // Windows-style path
          lineNumber: 10,
          aiBlameCommitId: 'commit-1',
          aiBlameInferenceId: 'inf-1',
          model: 'gpt-4',
          toolName: 'cursor',
          commitSha: 'abc123',
          type: 'AI_GENERATED',
        },
      ]

      const index = buildCommitAttributionIndex(attributions)

      // Should be normalized to forward slashes
      expect(index.has('src/windows/file.ts')).toBe(true)
      expect(index.has('src\\windows\\file.ts')).toBe(false)
    })
  })

  describe('getAIBlameInfoLine integration', () => {
    describe('getAIBlameInfoLine integration', () => {
      it('returns attribution for exact file path and line number', async () => {
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
                inferenceType: 'AI_GENERATED',
              },
            ],
          },
        }

        const mockGqlClient = {
          analyzeCommitForExtensionAIBlame: vi
            .fn()
            .mockResolvedValue(mockAnalyzeResult),
        }

        const { createGQLClient } =
          await import('../src/shared/gqlClientFactory')
        ;(createGQLClient as any).mockResolvedValue(mockGqlClient)

        const { AIBlameCache } = await import('../src/ui/AIBlameCache')
        const cache = new AIBlameCache('repo-url', 'org-id', '/repo')

        const result = await cache.getAIBlameInfoLine(
          'abc123',
          '/repo/src/file.ts',
          10
        )

        expect(result).toEqual({
          id: 'attr-1',
          aiBlameCommitId: 'commit-1',
          aiBlameInferenceId: 'inf-1',
          filePath: 'src/file.ts',
          lineNumber: 10,
          model: 'gpt-4',
          toolName: 'cursor',
          commitSha: 'abc123',
          type: 'AI_GENERATED',
        })
      })

      it('returns null for non-existent file/line combination', async () => {
        const mockAnalyzeResult = {
          analyzeCommitForAIBlame: {
            __typename: 'ProcessAIBlameFinalResult',
            attributions: [],
          },
        }

        const mockGqlClient = {
          analyzeCommitForExtensionAIBlame: vi
            .fn()
            .mockResolvedValue(mockAnalyzeResult),
        }

        const { createGQLClient } =
          await import('../src/shared/gqlClientFactory')
        ;(createGQLClient as any).mockResolvedValue(mockGqlClient)

        const { AIBlameCache } = await import('../src/ui/AIBlameCache')
        const cache = new AIBlameCache('repo-url', 'org-id', '/repo')

        const result = await cache.getAIBlameInfoLine(
          'abc123',
          '/repo/src/nonexistent.ts',
          10
        )

        expect(result).toBeNull()
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
                inferenceType: 'AI_GENERATED', // This is the correct field name
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

        const { getAuthenticatedGQLClient } =
          await import('../src/mobbdev_src/commands/handleMobbLogin')
        ;(getAuthenticatedGQLClient as any).mockResolvedValue(mockGqlClient)

        const { createGQLClient } =
          await import('../src/shared/gqlClientFactory')
        ;(createGQLClient as any).mockResolvedValue(mockGqlClient)

        const { AIBlameCache } = await import('../src/ui/AIBlameCache')
        const cache = new AIBlameCache('repo-url', 'org-id')

        // Start three concurrent requests for same commit using getAIBlameInfoLine
        // These calls will still test the same deduplication logic in ensureCommitLoaded
        const promises = [
          cache.getAIBlameInfoLine('abc123', 'src/file.ts', 10),
          cache.getAIBlameInfoLine('abc123', 'src/file.ts', 10),
          cache.getAIBlameInfoLine('abc123', 'src/file.ts', 10),
        ]

        const results = await Promise.all(promises)

        // All should return same result - the specific attribution for line 10
        const expectedResult = {
          id: 'attr-1',
          aiBlameCommitId: 'commit-1',
          aiBlameInferenceId: 'inf-1',
          filePath: 'src/file.ts',
          lineNumber: 10,
          model: 'gpt-4',
          toolName: 'cursor',
          commitSha: 'abc123',
          type: 'AI_GENERATED',
        }

        expect(results[0]).toEqual(expectedResult)
        expect(results[1]).toEqual(expectedResult)
        expect(results[2]).toEqual(expectedResult)

        // But GraphQL client should only be called once
        expect(
          mockGqlClient.analyzeCommitForExtensionAIBlame
        ).toHaveBeenCalledTimes(1)
      })
    })

    describe('error handling', () => {
      it('handles network errors gracefully', async () => {
        const { getAuthenticatedGQLClient } =
          await import('../src/mobbdev_src/commands/handleMobbLogin')
        ;(getAuthenticatedGQLClient as any).mockRejectedValue(
          new Error('Network error')
        )

        const { AIBlameCache } = await import('../src/ui/AIBlameCache')
        const { logger } = await import('../src/shared/logger')

        const cache = new AIBlameCache('repo-url', 'org-id')

        const result = await cache.getAIBlameInfoLine(
          'abc123',
          'src/file.ts',
          10
        )

        expect(result).toBeNull()
        // Note: the error is logged both in the wrapper and in the cache layer.
        expect(logger.error).toHaveBeenCalledWith(
          expect.objectContaining({
            error: expect.any(Error),
            commitSha: 'abc123',
          }),
          expect.stringContaining('AIBlameCache: Error analyzing commit abc123')
        )
      })

      it('handles missing organization or repo URL', async () => {
        const { AIBlameCache } = await import('../src/ui/AIBlameCache')
        const { logger } = await import('../src/shared/logger')

        const cache = new AIBlameCache('', '') // Empty repo/org

        // Test error handling through getAIBlameInfoLine since getAIBlameInfo was removed
        const result = await cache.getAIBlameInfoLine(
          'abc123',
          'src/file.ts',
          10
        )

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

        const { getAuthenticatedGQLClient } =
          await import('../src/mobbdev_src/commands/handleMobbLogin')
        ;(getAuthenticatedGQLClient as any).mockResolvedValue(mockGqlClient)

        const { AIBlameCache } = await import('../src/ui/AIBlameCache')
        const { logger } = await import('../src/shared/logger')

        const cache = new AIBlameCache('repo-url', 'org-id')

        const result = await cache.getAIBlamePrompt('attr-123')

        expect(result).toBeNull()
        expect(logger.error).toHaveBeenCalledWith(
          expect.objectContaining({
            error: expect.any(Error),
          }),
          expect.stringContaining('Error during GetAiBlameAttributionPrompt')
        )
      })
    })
  })
})
