import { describe, expect, it, vi } from 'vitest'

import {
  CopilotRecordForFilePath,
  extractFilePathFromRecord,
} from '../../src/copilot/extractFilePath'

vi.mock('vscode', () => ({}))

vi.mock('../../src/shared/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(response: unknown[] | undefined): CopilotRecordForFilePath {
  return { request: { response } }
}

function toolItem(uris: Record<string, unknown>, toolId = 'tool_1') {
  return {
    kind: 'toolInvocationSerialized',
    toolId,
    invocationMessage: { uris },
  }
}

function textEditItem(filePath: string) {
  return { kind: 'textEditGroup', uri: { path: filePath } }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractFilePathFromRecord', () => {
  it('Strategy 1: file:// URI → decoded absolute path', () => {
    const record = makeRecord([toolItem({ 'file:///Users/test/file.ts': {} })])
    expect(extractFilePathFromRecord(record)).toBe('/Users/test/file.ts')
  })

  it('Strategy 1: URI decoding (spaces encoded as %20)', () => {
    const record = makeRecord([
      toolItem({ 'file:///Users/test/my%20project/file.ts': {} }),
    ])
    expect(extractFilePathFromRecord(record)).toBe(
      '/Users/test/my project/file.ts'
    )
  })

  it('Strategy 1: skip non-absolute paths, fall back to Strategy 2', () => {
    const record = makeRecord([
      toolItem({ 'relative/path.ts': {} }),
      textEditItem('/Users/fallback/file.ts'),
    ])
    expect(extractFilePathFromRecord(record)).toBe('/Users/fallback/file.ts')
  })

  it('Strategy 2: textEditGroup with absolute uri.path', () => {
    const record = makeRecord([textEditItem('/Users/edit/file.ts')])
    expect(extractFilePathFromRecord(record)).toBe('/Users/edit/file.ts')
  })

  it('Strategy 2: skip non-absolute textEditGroup paths', () => {
    const record = makeRecord([textEditItem('relative/file.ts')])
    expect(extractFilePathFromRecord(record)).toBeUndefined()
  })

  it('Fallback: no matching items → undefined', () => {
    const record = makeRecord([
      { kind: 'thinking', content: 'hmm' },
      { kind: 'markdownContent', content: { value: 'hello' } },
    ])
    expect(extractFilePathFromRecord(record)).toBeUndefined()
  })

  it('Non-array response → undefined', () => {
    const record = makeRecord(undefined)
    expect(extractFilePathFromRecord(record)).toBeUndefined()
  })

  it('Priority: Strategy 1 wins over Strategy 2', () => {
    const record = makeRecord([
      textEditItem('/Users/edit/file.ts'),
      toolItem({ 'file:///Users/tool/file.ts': {} }),
    ])
    expect(extractFilePathFromRecord(record)).toBe('/Users/tool/file.ts')
  })

  it('Empty response array → undefined', () => {
    const record = makeRecord([])
    expect(extractFilePathFromRecord(record)).toBeUndefined()
  })
})
