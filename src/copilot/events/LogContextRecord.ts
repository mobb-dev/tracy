// logContextRecord.ts
// Minimal parser for copilot inline edit logs — extract added lines only.
import yaml from 'yaml'

export type ISerializedInlineEditLogContext = {
  requestId: number
  time: number
  filePath: string
  version: number
  statelessNextEditProviderId?: string
  nextEditRequest?: unknown
  diagnosticsResultEdit?: string
  resultEdit?: string
  isCachedResult: boolean
  prompt?: string
  error: string
  response?: string
  responseResults: string
  providerStartTime?: number
  providerEndTime?: number
  fetchStartTime?: number
  fetchEndTime?: number
  logs: string[]
  isAccepted?: boolean
  languageContext?: unknown
  diagnostics?: unknown
}

/* -------------------------------------------------------
   Extract added lines from responseResults (preferred)
   Cursor logs them as YAML-ish blocks:
   - replaceRange:
       start: 1900
       endExclusive: 2016
     newText: |2-
         line1
         line2
---------------------------------------------------------*/
export function addedLinesFromResponseResults(
  responseResults?: string
): string[] {
  if (!responseResults) {
    return []
  }

  let parsed: unknown
  try {
    parsed = yaml.parse(responseResults)
  } catch {
    return []
  }

  if (!Array.isArray(parsed)) {
    return []
  }

  const out: string[] = []

  for (const entry of parsed) {
    if (!entry?.newText) {
      continue
    }

    // newText is *already* the exact multiline string
    const lines = entry.newText.replace(/\r\n/g, '\n').split('\n')

    for (const line of lines) {
      // keep exact whitespace; skip EMPTY lines if you want
      if (line.trim().length > 0) {
        out.push(line)
      }
    }
  }

  return out
}

/* -------------------------------------------------------
   Extract added lines from resultEdit (fallback)
   resultEdit looks like a diff snippet with lines prefixed with "+"
---------------------------------------------------------*/
export function addedLinesFromResultEdit(resultEdit?: string): string[] {
  if (!resultEdit) {
    return []
  }

  const lines = resultEdit.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []

  for (const line of lines) {
    // Match lines that start with +, optional whitespace, digits, and whitespace
    const match = line.match(/^(\+\s*\d+\s)(.*)/)
    if (match) {
      out.push(match[2]) // keep everything after the pattern
    }
  }

  return out
}

/* -------------------------------------------------------
   The minimal record wrapper
---------------------------------------------------------*/
export class LogContextRecord {
  constructor(public event: ISerializedInlineEditLogContext) {}

  static fromJson(raw: string | unknown): LogContextRecord {
    const obj =
      typeof raw === 'string'
        ? (JSON.parse(raw) as ISerializedInlineEditLogContext)
        : (raw as ISerializedInlineEditLogContext)

    return new LogContextRecord(obj)
  }

  /**
   * Extract added lines from:
   *   1) responseResults (structured YAML-form diff)
   *   2) resultEdit fallback (+line format)
   */
  computeAddedLines(): string[] {
    const e = this.event

    // Highest-confidence source
    const fromResult = addedLinesFromResultEdit(e.resultEdit)
    if (fromResult.length > 0) {
      return fromResult
    }

    // Fallback source
    const fromResp = addedLinesFromResponseResults(e.responseResults)
    if (fromResp.length > 0) {
      return fromResp
    }

    return []
  }
}
