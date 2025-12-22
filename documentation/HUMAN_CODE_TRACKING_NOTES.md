## Human Code Tracking Notes

What the Human tracker does

- Listens to text document changes in the active editor only.
- Groups contiguous human edits into "segments" (line ranges).
- Closes a segment when:
    - You pause typing for ~`segmentIdleMs`, or
    - You make an edit outside the current contiguous line window (beyond the adjacency gap), or
    - The segment grows beyond `segmentMaxChars` (safety cap), or
    - The time since the last edit in the segment exceeds `maxSegmentDurationMs`, or
    - A non-human edit group occurs (multi-change event or large single insert). In this case we force-close any open human segment and ignore the non-human group itself.
- For each closed segment we:
    - Compute basic metrics (duration, edit cadence).
    - Classify it using conservative heuristics and treat only clearly human segments as HUMAN.
    - If classified as HUMAN, we read the full content of every line in the segment's line span into a single `changedLines` string.
    - If the non-whitespace character count of `changedLines` is above the configured threshold, we either emit a DRY-RUN upload log entry in the shared output channel or, when `uploadEnabled` is true, upload the segment via the AI blame pipeline.

Settings

- The human tracker uses internal defaults; there are no user-facing settings for this feature.

Internal configuration (for developers)

- Human tracker configuration
    - All tracker and classifier thresholds live in `src/human/config.ts` (`HUMAN_TRACKING_CONFIG`). Key fields:
        - `segmentIdleMs` — idle gap to close a segment (ms).
        - `segmentMaxChars` — max characters buffered per segment.
        - `maxSegmentDurationMs` — max time the segment can live before it is force-closed (ms).
        - `adjacencyGapLines` — maximum gap (in lines) to merge edits into a single segment.
        - `minSegmentCharsWithNoWhitespace` — minimum total length of changed lines required to upload (excluding whitespace).
        - `uploadEnabled` — whether to actually upload segments or just log artifacts.
    - Classifier thresholds (cadence, paste-like detection, etc.) are under `HUMAN_TRACKING_CONFIG.classifier` and used by:
        - `src/human/eventClassifier.ts` (per-change event classification: multi-change vs large insert vs single small change).
        - `src/human/segmentClassifier.ts` (future preparation for more complex classification logic per segment - we currently only use the event classifier).

- All thresholds above are internal constants; changing them requires a rebuild.
