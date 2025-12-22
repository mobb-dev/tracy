import { createTwoFilesPatch } from 'diff'

import type { ToolCallReplacement } from '../events/ToolCall'

export function applyReplacements(
  baseline: string,
  replacements: ToolCallReplacement[]
): string {
  if (!Array.isArray(replacements) || replacements.length === 0) {
    return baseline
  }
  const len = baseline.length
  const reps = [...replacements]
    .filter(
      (r) =>
        Number.isFinite(r.replaceRange?.start) &&
        Number.isFinite(r.replaceRange?.endExclusive)
    )
    .map((r) => ({
      start: r.replaceRange.start as number,
      end: r.replaceRange.endExclusive as number,
      text: r.newText,
    }))
    .filter((r) => r.start >= 0 && r.end >= r.start && r.end <= len)
    .sort((a, b) => a.start - b.start)

  let out = ''
  let cursor = 0
  for (const r of reps) {
    if (r.start < cursor) {
      // overlapping or out-of-order; skip to avoid corruption
      continue
    }
    out += baseline.slice(cursor, r.start)
    out += r.text ?? ''
    cursor = r.end
  }
  out += baseline.slice(cursor)
  return out
}

export function createUnifiedDiffFromReplacements(
  filePath: string,
  baselineContent: string,
  replacements: ToolCallReplacement[]
): { afterText: string; unifiedDiff: string } {
  const before = baselineContent.replace(/\r\n/g, '\n')
  const afterText = applyReplacements(before, replacements)
  const unifiedDiff =
    before === afterText
      ? ''
      : createTwoFilesPatch(
          `a/${filePath}`,
          `b/${filePath}`,
          before,
          afterText,
          '',
          '',
          { context: 3 }
        )
  return { afterText, unifiedDiff }
}

export function extractAddedLinesFromUnifiedDiff(unifiedDiff: string): string {
  if (typeof unifiedDiff !== 'string' || unifiedDiff.length === 0) {
    return ''
  }
  const lines = unifiedDiff.replace(/\r\n/g, '\n').split('\n')
  const added: string[] = []

  for (const line of lines) {
    // Skip file headers and hunk headers
    if (
      line.startsWith('+++ ') ||
      line.startsWith('--- ') ||
      line.startsWith('@@')
    ) {
      continue
    }
    // Only collect true additions; keep exact whitespace by slicing off the leading '+' only
    if (line.startsWith('+')) {
      added.push(line.slice(1))
    }
  }

  return added.join('\n')
}
