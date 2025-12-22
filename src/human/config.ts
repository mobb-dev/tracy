// Centralized configuration for human-typing tracking.
// These are internal defaults (not user-facing) and can be
// wired to VS Code settings in the future if needed.

export const HUMAN_TRACKING_CONFIG = {
  // Segment lifecycle
  segmentIdleMs: 30000, // Idle gap between edits before idle-flush closes the segment
  segmentMaxChars: 10000, // Max chars per segment
  adjacencyGapLines: 1, // Max gap (in lines) to merge edits into a single segment
  maxSegmentDurationMs: 60000, // Max time between edits in a segment before it is force-closed

  // Upload behavior
  minSegmentCharsWithNoWhitespace: 30, // Min non-whitespace chars per segment to upload
  uploadEnabled: true, // Whether to actually upload (vs dry-run logging only)

  // Classifier thresholds (heuristics on a closed segment)
  classifier: {
    // Coarse non-human edit detection
    largeSingleInsertThreshold: 10, // Paste/generation detection threshold (chars) per single change
  },
} as const
