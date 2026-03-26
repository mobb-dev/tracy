import { describe, expect, it, vi } from 'vitest'

import type { BubbleDataForFilePath } from '../src/cursor/extractFilePath'
import { extractFilePath } from '../src/cursor/extractFilePath'

vi.mock('vscode', () => ({}))
vi.mock('../src/shared/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

describe('extractFilePath', () => {
  it('extracts file path from rawArgs.file_path', () => {
    const bubble: BubbleDataForFilePath = {
      toolFormerData: {
        name: 'edit_file',
        rawArgs: JSON.stringify({ file_path: '/workspace/src/index.ts' }),
        params: '{}',
      },
    }
    expect(extractFilePath(bubble)).toBe('/workspace/src/index.ts')
  })

  it('extracts file path from rawArgs.path (read_file_v2)', () => {
    const bubble: BubbleDataForFilePath = {
      toolFormerData: {
        name: 'read_file_v2',
        rawArgs: JSON.stringify({ path: '/workspace/src/app.ts' }),
        params: '{}',
      },
    }
    expect(extractFilePath(bubble)).toBe('/workspace/src/app.ts')
  })

  it('extracts file path from params.relativeWorkspacePath (edit_file_v2)', () => {
    const bubble: BubbleDataForFilePath = {
      toolFormerData: {
        name: 'edit_file_v2',
        rawArgs: '{}',
        params: JSON.stringify({
          relativeWorkspacePath: '/workspace/src/main.ts',
        }),
      },
    }
    expect(extractFilePath(bubble)).toBe('/workspace/src/main.ts')
  })

  it('extracts file path from params.targetFile', () => {
    const bubble: BubbleDataForFilePath = {
      toolFormerData: {
        name: 'read_file_v2',
        rawArgs: '{}',
        params: JSON.stringify({ targetFile: '/workspace/src/util.ts' }),
      },
    }
    expect(extractFilePath(bubble)).toBe('/workspace/src/util.ts')
  })

  it('falls back to codeBlocks[0].uri.path', () => {
    const bubble: BubbleDataForFilePath = {
      toolFormerData: {
        name: 'edit_file',
        rawArgs: '{}',
        params: '{}',
      },
      codeBlocks: [{ uri: { path: '/workspace/src/fallback.ts' } }],
    }
    expect(extractFilePath(bubble)).toBe('/workspace/src/fallback.ts')
  })

  it('returns undefined when no file path found', () => {
    const bubble: BubbleDataForFilePath = {
      toolFormerData: {
        name: 'edit_file',
        rawArgs: '{}',
        params: '{}',
      },
    }
    expect(extractFilePath(bubble)).toBeUndefined()
  })

  it('ignores relative paths in rawArgs', () => {
    const bubble: BubbleDataForFilePath = {
      toolFormerData: {
        name: 'edit_file',
        rawArgs: JSON.stringify({ file_path: 'relative/path.ts' }),
        params: '{}',
      },
    }
    expect(extractFilePath(bubble)).toBeUndefined()
  })

  it('handles invalid rawArgs JSON gracefully', () => {
    const bubble: BubbleDataForFilePath = {
      toolFormerData: {
        name: 'edit_file',
        rawArgs: 'not valid json',
        params: '{}',
      },
    }
    expect(extractFilePath(bubble)).toBeUndefined()
  })

  it('returns undefined when no toolFormerData', () => {
    const bubble: BubbleDataForFilePath = {}
    expect(extractFilePath(bubble)).toBeUndefined()
  })

  it('prefers rawArgs over params when both have paths', () => {
    const bubble: BubbleDataForFilePath = {
      toolFormerData: {
        name: 'edit_file_v2',
        rawArgs: JSON.stringify({ file_path: '/workspace/rawargs.ts' }),
        params: JSON.stringify({
          relativeWorkspacePath: '/workspace/params.ts',
        }),
      },
    }
    expect(extractFilePath(bubble)).toBe('/workspace/rawargs.ts')
  })
})
