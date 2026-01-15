// Simplified tool call parser focused on inference extraction

import {
  createUnifiedDiffFromReplacements,
  extractAddedLinesFromUnifiedDiff,
} from '../utils/diff'

export const EDIT_TOOLS = [
  'insert_edit_into_file',
  'apply_patch',
  'replace_string_in_file',
  'create_file',
  // VS Code Copilot tools added to fix missing inference capture (GitHub Issues #261744, #263274)
  // These tools were being used by VS Code Copilot since at least Nov 2025 but weren't captured
  // until Jan 8, 2026, causing silent inference loss in production
  'multi_replace_string_in_file', // Batch edits with multiple oldString/newString replacements
  'editFiles', // VS Code edit agent tool set (groups file editing tools)
] as const

export const READ_TOOLS = ['read_file'] as const

export type ISerializedToolCall = {
  id: string
  tool: string
  args: Record<string, unknown>
  time: Date
  filePath?: string
  replacements?: ToolCallReplacement[]
  [key: string]: unknown // Allow other properties but we don't care about them
}

export type ToolCallReplacement = {
  replaceRange: { start: number; endExclusive: number }
  newText: string
}

/* -------------------------------------------------------
   Tool-specific inference parsers
---------------------------------------------------------*/

export function inferenceFromReplaceString(
  args: Record<string, unknown>
): string | undefined {
  const oldString =
    typeof args['oldString'] === 'string' ? args['oldString'] : undefined
  const newString =
    typeof args['newString'] === 'string' ? args['newString'] : undefined

  if (!newString) {
    return undefined
  }

  // If we don't have an oldString, treat everything as new
  if (!oldString) {
    const allLines = newString.split('\n').map((l) => l.trimEnd())
    const nonEmpty = allLines.filter((l) => l.trim().length > 0)
    return nonEmpty.join('\n') || undefined
  }

  const oldLines = oldString.split('\n').map((l) => l.trimEnd())
  const newLines = newString.split('\n').map((l) => l.trimEnd())

  // "New" = lines that don't appear verbatim in oldString
  const addedLines = newLines.filter((line) => !oldLines.includes(line))

  const result = addedLines.filter((l) => l.trim().length > 0).join('\n')
  return result || undefined
}

export function inferenceFromCreateFile(
  args: Record<string, unknown>
): string | undefined {
  const content =
    (typeof args['code'] === 'string' ? args['code'] : undefined) ??
    (typeof args['content'] === 'string' ? args['content'] : undefined)

  const trimmed = content?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

export function inferenceFromApplyPatch(
  args: Record<string, unknown>
): string | undefined {
  const patch =
    (typeof args['patch'] === 'string' && args['patch']) ||
    (typeof args['diff'] === 'string' && args['diff']) ||
    (typeof args['input'] === 'string' && args['input']) ||
    ''

  if (!patch) {
    return undefined
  }

  const lines = patch.split('\n')
  const addedLines: string[] = []

  for (const line of lines) {
    // We only want real additions, not headers like "+++ ..."
    if (line.startsWith('+') && !line.startsWith('+++')) {
      // Remove leading '+' but keep original indentation
      const withoutPlus = line.slice(1).replace(/\r$/, '')
      if (withoutPlus.trim().length > 0) {
        addedLines.push(withoutPlus)
      }
    }
  }

  const result = addedLines.join('\n')
  return result || undefined
}

/**
 * Extract inference from VS Code Copilot's multi_replace_string_in_file tool.
 *
 * **Production Bug Fix (Jan 8, 2026):**
 * VS Code Copilot was using this tool since at least Nov 24, 2025 (confirmed in test
 * messages.json) but the extension wasn't capturing these inferences, causing silent
 * data loss in production. See GitHub Issue #261744, #263274 for tool documentation.
 *
 * Tool format:
 * - args.replacements: array of {filePath, oldString, newString, explanation?}
 * - Each replacement is processed independently to extract added lines
 *
 * @param args Tool call arguments containing replacements array
 * @returns Concatenated added lines from all replacements, or undefined if none
 */
export function inferenceFromMultiReplace(
  args: Record<string, unknown>
): string | undefined {
  const { replacements } = args
  if (!Array.isArray(replacements)) {
    return undefined
  }

  const allAddedLines: string[] = []

  for (const replacement of replacements) {
    if (typeof replacement !== 'object' || replacement === null) {
      continue
    }

    const rep = replacement as Record<string, unknown>
    const oldString =
      typeof rep['oldString'] === 'string' ? rep['oldString'] : undefined
    const newString =
      typeof rep['newString'] === 'string' ? rep['newString'] : undefined

    if (!newString) {
      continue
    }

    // Use the same logic as inferenceFromReplaceString
    const newLines = newString.split('\n').map((l) => l.trimEnd())

    if (!oldString) {
      // If no oldString, treat everything as new
      const nonEmpty = newLines.filter((l) => l.trim().length > 0)
      allAddedLines.push(...nonEmpty)
    } else {
      const oldLines = oldString.split('\n').map((l) => l.trimEnd())
      // "New" = lines that don't appear verbatim in oldString
      const addedLines = newLines.filter((line) => !oldLines.includes(line))
      const nonEmpty = addedLines.filter((l) => l.trim().length > 0)
      allAddedLines.push(...nonEmpty)
    }
  }

  const result = allAddedLines.join('\n')
  return result || undefined
}

/* -------------------------------------------------------
   Simplified ToolCall class
---------------------------------------------------------*/

export class ToolCall {
  constructor(
    public id: string,
    public tool: string,
    public args: Record<string, unknown>,
    public filePath: string = '',
    public replacements: ToolCallReplacement[] = [],
    public time: Date = new Date()
  ) {}

  static fromJson(raw: string | unknown): ToolCall {
    const obj =
      typeof raw === 'string'
        ? JSON.parse(raw)
        : (raw as Record<string, unknown>)

    // Parse args (may be double-encoded JSON string or direct object)
    let args: Record<string, unknown> = {}
    const argsField = obj['args']
    if (typeof argsField === 'string') {
      try {
        args = JSON.parse(argsField) as Record<string, unknown>
      } catch {
        args = {}
      }
    } else if (typeof argsField === 'object' && argsField !== null) {
      args = argsField as Record<string, unknown>
    }

    // Extract filePath - prefer args.filePath, fall back to first edits[].path
    let filePath: string = ''
    const { filePath: argsFilePath } = args
    if (typeof argsFilePath === 'string') {
      filePath = argsFilePath
    }
    const { edits } = obj
    if (!filePath && Array.isArray(edits) && edits.length > 0) {
      const first = edits[0]
      if (
        typeof first === 'object' &&
        first !== null &&
        typeof first['path'] === 'string'
      ) {
        filePath = first['path']
      }
    }

    // Extract replacements from the top-level "edits" array (simplified version)
    const replacements: ToolCallReplacement[] = []
    if (Array.isArray(edits)) {
      for (const fileEdit of edits) {
        if (typeof fileEdit !== 'object' || fileEdit === null) {
          continue
        }
        const inner = fileEdit['edits']
        if (typeof inner !== 'object' || inner === null) {
          continue
        }
        const reps = inner['replacements']
        if (!Array.isArray(reps)) {
          continue
        }

        for (const r of reps) {
          if (typeof r !== 'object' || r === null) {
            continue
          }
          const { replaceRange, newText } = r

          if (
            typeof replaceRange === 'object' &&
            replaceRange !== null &&
            typeof replaceRange['start'] === 'number' &&
            typeof replaceRange['endExclusive'] === 'number' &&
            typeof newText === 'string'
          ) {
            replacements.push({
              replaceRange: {
                start: replaceRange['start'],
                endExclusive: replaceRange['endExclusive'],
              },
              newText,
            })
          }
        }
      }
    }

    // Parse time
    const timeDate = obj['time']
      ? typeof obj['time'] === 'number' || typeof obj['time'] === 'string'
        ? new Date(obj['time'])
        : new Date()
      : new Date()

    return new ToolCall(
      typeof obj['id'] === 'string' ? obj['id'] : '',
      typeof obj['tool'] === 'string' ? obj['tool'] : 'unknown',
      args,
      filePath,
      replacements,
      timeDate
    )
  }

  /**
   * Extract inference (added/new content) based on tool type
   */
  getInference(): string | undefined {
    switch (this.tool) {
      case 'replace_string_in_file':
        return inferenceFromReplaceString(this.args)
      case 'create_file':
        return inferenceFromCreateFile(this.args)
      case 'apply_patch':
        return inferenceFromApplyPatch(this.args)
      case 'multi_replace_string_in_file':
        return inferenceFromMultiReplace(this.args)
      case 'editFiles':
        // VS Code edit agent - try both patch and multi-replace formats
        return (
          inferenceFromApplyPatch(this.args) ||
          inferenceFromMultiReplace(this.args)
        )
      default:
        return undefined
    }
  }

  /**
   * Backup inference extraction using replacements and baseline content
   * This is used when the primary getInference() method fails
   */
  getInferenceFromReplacements(baselineContent: string): string | undefined {
    if (!this.replacements || this.replacements.length === 0) {
      return undefined
    }

    try {
      const { unifiedDiff } = createUnifiedDiffFromReplacements(
        this.filePath,
        baselineContent,
        this.replacements
      )

      if (unifiedDiff && unifiedDiff.trim().length > 0) {
        return extractAddedLinesFromUnifiedDiff(unifiedDiff)
      }
    } catch (error) {
      // If diff generation fails, return undefined
      return undefined
    }

    return undefined
  }
}
