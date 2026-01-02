export const SegmentClassification = {
  HUMAN_POSITIVE: 'human_positive',
} as const
export type SegmentClassificationCode =
  (typeof SegmentClassification)[keyof typeof SegmentClassification]

export const EventClassification = {
  MULTI_CHANGE: 'multi-change',
  MULTI_LINE_HUMAN_EDIT: 'multi-line-human-edit',
  LARGE_INSERT: 'large-insert',
  WHITE_SPACE_INSERT: 'white-space-insert',
  SINGLE_CHANGE: 'single-small-change',
  EMPTY: 'empty',
} as const
export type EventClassificationCode =
  (typeof EventClassification)[keyof typeof EventClassification]

export const TOOL_NAME_HUMAN_TYPING = 'human_typing'
export const UPLOAD_MODEL_HUMAN = 'human'
export const UPLOAD_TOOL_CURSOR = 'Cursor'
export const UPLOAD_TOOL_VSCODE = 'VSCode'

export function isSegmentHuman(c: SegmentClassificationCode): boolean {
  return c === SegmentClassification.HUMAN_POSITIVE
}

export function isEventHuman(
  eventClassification: EventClassificationCode
): boolean {
  // Exhaustive switch ensures compile-time error if new classification is added
  switch (eventClassification) {
    case EventClassification.SINGLE_CHANGE:
    case EventClassification.MULTI_LINE_HUMAN_EDIT:
    case EventClassification.WHITE_SPACE_INSERT:
      return true
    case EventClassification.MULTI_CHANGE:
    case EventClassification.LARGE_INSERT:
    case EventClassification.EMPTY:
      return false
    default: {
      // Compile-time exhaustiveness check - will error if a case is missing
      const _exhaustive: never = eventClassification
      return _exhaustive
    }
  }
}

// User-editable document URI schemes
export const AllowedSchemes = ['file', 'untitled', 'vscode-remote'] as const
