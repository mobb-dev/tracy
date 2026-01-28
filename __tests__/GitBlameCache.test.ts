import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => ({}))

vi.mock('../src/shared/logger', () => {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  }
})

vi.mock('fs', () => ({
  promises: {
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('os', () => ({
  tmpdir: vi.fn(() => '/tmp'),
}))

vi.mock('../src/mobbdev_src/utils/gitUtils', () => ({
  createGitWithLogging: vi.fn(),
}))

describe('GitBlameCache', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  it('does not hang when git cannot be spawned (error event)', async () => {
    const { createGitWithLogging } = await import(
      '../src/mobbdev_src/utils/gitUtils'
    )
    const { logger } = await import('../src/shared/logger')

    // Mock git.raw() to throw an error (simulating git command failure)
    const mockGit = {
      raw: vi.fn().mockRejectedValue(new Error('spawn git ENOENT')),
    }
    ;(
      createGitWithLogging as unknown as ReturnType<typeof vi.fn>
    ).mockReturnValue(mockGit)

    const { GitBlameCache } = await import('../src/ui/GitBlameCache')

    // Minimal document shape used by GitBlameCache
    const doc = {
      uri: { fsPath: '/repo/file.ts' },
      fileName: '/repo/file.ts',
      version: 1,
      isDirty: false,
      getText: () => 'const x = 1\n',
    } as any

    const cache = new GitBlameCache('/repo')

    const result = await cache.getBlame(doc)

    expect(result).toBeNull()
    expect(logger.warn).toHaveBeenCalled()
    expect(createGitWithLogging).toHaveBeenCalled()
  })

  describe('document version tracking', () => {
    it('uses cached result when document version matches', async () => {
      const { createGitWithLogging } = await import(
        '../src/mobbdev_src/utils/gitUtils'
      )
      const { GitBlameCache } = await import('../src/ui/GitBlameCache')

      // Mock successful git blame output
      const mockGit = {
        raw: vi
          .fn()
          .mockResolvedValue('abc123 1 1 1\nauthor Test Author\n1) line 1\n'),
      }
      ;(
        createGitWithLogging as unknown as ReturnType<typeof vi.fn>
      ).mockReturnValue(mockGit)

      const doc = {
        uri: { fsPath: '/repo/file.ts' },
        fileName: '/repo/file.ts',
        version: 1,
        isDirty: false,
        getText: () => 'const x = 1\n',
      } as any

      const cache = new GitBlameCache('/repo')

      const result1 = await cache.getBlame(doc)
      expect(result1).not.toBeNull()

      // Reset mock for second call
      vi.mocked(createGitWithLogging).mockClear()
      ;(
        createGitWithLogging as unknown as ReturnType<typeof vi.fn>
      ).mockReturnValue(mockGit)

      // Second call with same document version should use cache
      const result2 = await cache.getBlame(doc)

      expect(result2).toEqual(result1)
      expect(createGitWithLogging).not.toHaveBeenCalled() // Should not call git again
    })

    it('fetches new data when document version changes', async () => {
      const { createGitWithLogging } = await import(
        '../src/mobbdev_src/utils/gitUtils'
      )
      const { GitBlameCache } = await import('../src/ui/GitBlameCache')

      // Mock first git result
      const mockGit1 = {
        raw: vi
          .fn()
          .mockResolvedValue('abc123 1 1 1\nauthor Test Author\n1) line 1\n'),
      }
      ;(
        createGitWithLogging as unknown as ReturnType<typeof vi.fn>
      ).mockReturnValue(mockGit1)

      const doc = {
        uri: { fsPath: '/repo/file.ts' },
        fileName: '/repo/file.ts',
        version: 1,
        isDirty: false,
        getText: () => 'const x = 1\n',
      } as any

      const cache = new GitBlameCache('/repo')

      const result1 = await cache.getBlame(doc)
      expect(result1).not.toBeNull()

      // Change document version
      doc.version = 2
      vi.mocked(createGitWithLogging).mockClear()

      // Mock second git result
      const mockGit2 = {
        raw: vi
          .fn()
          .mockResolvedValue(
            'def456 1 1 1\nauthor New Author\n1) modified line\n'
          ),
      }
      ;(
        createGitWithLogging as unknown as ReturnType<typeof vi.fn>
      ).mockReturnValue(mockGit2)

      const result2 = await cache.getBlame(doc)

      expect(createGitWithLogging).toHaveBeenCalled() // Should call git again
      expect(result2).not.toEqual(result1) // Results should be different
      expect(result2?.documentVersion).toBe(2)
    })
  })

  describe('dirty file handling', () => {
    it('creates temp file for dirty documents', async () => {
      const fs = await import('fs')
      const { createGitWithLogging } = await import(
        '../src/mobbdev_src/utils/gitUtils'
      )
      const { GitBlameCache } = await import('../src/ui/GitBlameCache')

      const mockGit = {
        raw: vi
          .fn()
          .mockResolvedValue('abc123 1 1 1\nauthor Test Author\n1) line 1\n'),
      }
      ;(
        createGitWithLogging as unknown as ReturnType<typeof vi.fn>
      ).mockReturnValue(mockGit)

      const dirtyDoc = {
        uri: { fsPath: '/repo/file.ts' },
        fileName: '/repo/file.ts',
        version: 1,
        isDirty: true,
        getText: () => 'const x = 2\n', // Changed content
      } as any

      const cache = new GitBlameCache('/repo')

      await cache.getBlame(dirtyDoc)

      // Should create temp file with document content
      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/\/tmp\/gitblamecache_\d+_file\.ts/),
        'const x = 2\n',
        'utf8'
      )

      // Should call git.raw() with --contents flag pointing to temp file
      expect(mockGit.raw).toHaveBeenCalledWith(
        expect.arrayContaining(['--contents'])
      )
    })

    it('cleans up temp files after git blame completes', async () => {
      const fs = await import('fs')
      const { createGitWithLogging } = await import(
        '../src/mobbdev_src/utils/gitUtils'
      )
      const { GitBlameCache } = await import('../src/ui/GitBlameCache')

      const mockGit = {
        raw: vi
          .fn()
          .mockResolvedValue('abc123 1 1 1\nauthor Test Author\n1) line 1\n'),
      }
      ;(
        createGitWithLogging as unknown as ReturnType<typeof vi.fn>
      ).mockReturnValue(mockGit)

      const dirtyDoc = {
        uri: { fsPath: '/repo/file.ts' },
        fileName: '/repo/file.ts',
        version: 1,
        isDirty: true,
        getText: () => 'const x = 2\n',
      } as any

      const cache = new GitBlameCache('/repo')

      await cache.getBlame(dirtyDoc)

      // Should clean up temp file
      expect(fs.promises.unlink).toHaveBeenCalledWith(
        expect.stringMatching(/\/tmp\/gitblamecache_\d+_file\.ts/)
      )
    })

    it('cleans up temp files even when git blame fails', async () => {
      const fs = await import('fs')
      const { createGitWithLogging } = await import(
        '../src/mobbdev_src/utils/gitUtils'
      )
      const { GitBlameCache } = await import('../src/ui/GitBlameCache')

      const mockGit = {
        raw: vi
          .fn()
          .mockRejectedValue(new Error('fatal: not a git repository')),
      }
      ;(
        createGitWithLogging as unknown as ReturnType<typeof vi.fn>
      ).mockReturnValue(mockGit)

      const dirtyDoc = {
        uri: { fsPath: '/repo/file.ts' },
        fileName: '/repo/file.ts',
        version: 1,
        isDirty: true,
        getText: () => 'const x = 2\n',
      } as any

      const cache = new GitBlameCache('/repo')

      const result = await cache.getBlame(dirtyDoc)

      expect(result).toBeNull()
      // Should still clean up temp file even on failure
      expect(fs.promises.unlink).toHaveBeenCalled()
    })
  })
})
