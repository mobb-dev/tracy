import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => ({}))

vi.mock('../src/shared/logger', () => {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }
})

vi.mock('fs', () => ({
  promises: {
    writeFile: vi.fn(),
    unlink: vi.fn(),
  },
}))

vi.mock('os', () => ({
  tmpdir: vi.fn(() => '/tmp'),
}))

vi.mock('child_process', () => {
  return {
    spawn: vi.fn(),
  }
})

class FakeStream extends EventEmitter {}
class FakeChildProcess extends EventEmitter {
  stdout: FakeStream | null = new FakeStream()
  stderr: FakeStream | null = new FakeStream()
  kill = vi.fn()
}

describe('GitBlameCache', () => {
  afterEach(() => {
    vi.resetAllMocks()
  })

  it('does not hang when git cannot be spawned (error event)', async () => {
    const { spawn } = await import('child_process')
    const { logger } = await import('../src/shared/logger')

    const proc = new FakeChildProcess()
    ;(spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(proc)

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

    // Simulate a spawn failure (e.g., ENOENT when git is missing)
    queueMicrotask(() => {
      proc.emit(
        'error',
        Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
      )
    })

    const result = await cache.getBlame(doc)

    expect(result).toBeNull()
    expect(logger.warn).toHaveBeenCalled()
    expect(spawn).toHaveBeenCalled()
  })

  describe('document version tracking', () => {
    it('uses cached result when document version matches', async () => {
      const { spawn } = await import('child_process')
      const { GitBlameCache } = await import('../src/ui/GitBlameCache')

      const proc = new FakeChildProcess()
      ;(spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(proc)

      const doc = {
        uri: { fsPath: '/repo/file.ts' },
        fileName: '/repo/file.ts',
        version: 1,
        isDirty: false,
        getText: () => 'const x = 1\n',
      } as any

      const cache = new GitBlameCache('/repo')

      // Mock successful git blame output
      queueMicrotask(() => {
        proc.stdout!.emit(
          'data',
          Buffer.from('abc123 1 1 1\nauthor Test Author\n1) line 1\n')
        )
        proc.emit('close', 0)
      })

      const result1 = await cache.getBlame(doc)
      expect(result1).not.toBeNull()

      // Reset mock for second call
      vi.mocked(spawn).mockClear()
      const proc2 = new FakeChildProcess()
      ;(spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(proc2)

      // Second call with same document version should use cache
      const result2 = await cache.getBlame(doc)

      expect(result2).toEqual(result1)
      expect(spawn).not.toHaveBeenCalled() // Should not spawn git again
    })

    it('fetches new data when document version changes', async () => {
      const { spawn } = await import('child_process')
      const { GitBlameCache } = await import('../src/ui/GitBlameCache')

      let proc = new FakeChildProcess()
      ;(spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(proc)

      const doc = {
        uri: { fsPath: '/repo/file.ts' },
        fileName: '/repo/file.ts',
        version: 1,
        isDirty: false,
        getText: () => 'const x = 1\n',
      } as any

      const cache = new GitBlameCache('/repo')

      // First call
      queueMicrotask(() => {
        proc.stdout!.emit(
          'data',
          Buffer.from('abc123 1 1 1\nauthor Test Author\n1) line 1\n')
        )
        proc.emit('close', 0)
      })

      const result1 = await cache.getBlame(doc)
      expect(result1).not.toBeNull()

      // Change document version
      doc.version = 2
      vi.mocked(spawn).mockClear()

      proc = new FakeChildProcess()
      ;(spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(proc)

      // Second call with different version should fetch new data
      queueMicrotask(() => {
        proc.stdout!.emit(
          'data',
          Buffer.from('def456 1 1 1\nauthor New Author\n1) modified line\n')
        )
        proc.emit('close', 0)
      })

      const result2 = await cache.getBlame(doc)

      expect(spawn).toHaveBeenCalled() // Should spawn git again
      expect(result2).not.toEqual(result1) // Results should be different
      expect(result2?.documentVersion).toBe(2)
    })
  })

  describe('dirty file handling', () => {
    it('creates temp file for dirty documents', async () => {
      const fs = await import('fs')
      const { spawn } = await import('child_process')
      const { GitBlameCache } = await import('../src/ui/GitBlameCache')

      const proc = new FakeChildProcess()
      ;(spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(proc)

      const dirtyDoc = {
        uri: { fsPath: '/repo/file.ts' },
        fileName: '/repo/file.ts',
        version: 1,
        isDirty: true,
        getText: () => 'const x = 2\n', // Changed content
      } as any

      const cache = new GitBlameCache('/repo')

      setTimeout(() => {
        proc.stdout!.emit(
          'data',
          Buffer.from('abc123 1 1 1\nauthor Test Author\n1) line 1\n')
        )
        proc.emit('close', 0)
      }, 0)

      await cache.getBlame(dirtyDoc)

      // Should create temp file with document content
      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/\/tmp\/gitblamecache_\d+_file\.ts/),
        'const x = 2\n',
        'utf8'
      )

      // Should call git with --contents flag pointing to temp file
      expect(spawn).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['--contents']),
        expect.any(Object)
      )
    })

    it('cleans up temp files after git blame completes', async () => {
      const fs = await import('fs')
      const { spawn } = await import('child_process')
      const { GitBlameCache } = await import('../src/ui/GitBlameCache')

      const proc = new FakeChildProcess()
      ;(spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(proc)

      const dirtyDoc = {
        uri: { fsPath: '/repo/file.ts' },
        fileName: '/repo/file.ts',
        version: 1,
        isDirty: true,
        getText: () => 'const x = 2\n',
      } as any

      const cache = new GitBlameCache('/repo')

      setTimeout(() => {
        proc.stdout!.emit(
          'data',
          Buffer.from('abc123 1 1 1\nauthor Test Author\n1) line 1\n')
        )
        proc.emit('close', 0)
      }, 0)

      await cache.getBlame(dirtyDoc)

      // Should clean up temp file
      expect(fs.promises.unlink).toHaveBeenCalledWith(
        expect.stringMatching(/\/tmp\/gitblamecache_\d+_file\.ts/)
      )
    })

    it('cleans up temp files even when git blame fails', async () => {
      const fs = await import('fs')
      const { spawn } = await import('child_process')
      const { GitBlameCache } = await import('../src/ui/GitBlameCache')

      const proc = new FakeChildProcess()
      ;(spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(proc)

      const dirtyDoc = {
        uri: { fsPath: '/repo/file.ts' },
        fileName: '/repo/file.ts',
        version: 1,
        isDirty: true,
        getText: () => 'const x = 2\n',
      } as any

      const cache = new GitBlameCache('/repo')

      setTimeout(() => {
        proc.stderr!.emit('data', Buffer.from('fatal: not a git repository'))
        proc.emit('close', 128)
      }, 0)

      const result = await cache.getBlame(dirtyDoc)

      expect(result).toBeNull()
      // Should still clean up temp file even on failure
      expect(fs.promises.unlink).toHaveBeenCalled()
    })
  })
})
