import * as vscode from 'vscode'

import { AppType, BaseMonitor } from '../shared/IMonitor'
import { logger } from '../shared/logger'
import { HUMAN_TRACKING_CONFIG } from './config'
import { detectEventClassification } from './eventClassifier'
import { HumanRecorder } from './recorder'
import { classifySegment } from './segmentClassifier'
import type { Segment } from './segmenter'
import { Segmenter } from './segmenter'
import { AllowedSchemes, isSegmentHuman } from './types'

// Pre-computed set for fast scheme checks (stateless)
const allowedSchemeSet = new Set(AllowedSchemes as readonly string[])

export class HumanTrackingSession extends BaseMonitor {
  readonly name = 'HumanTrackingSession'
  private readonly segmenter = new Segmenter()
  private readonly recorder: HumanRecorder
  private readonly subscriptions: vscode.Disposable[] = []
  private readonly idleTimers = new Map<string, NodeJS.Timeout>()
  private readonly segmentIdleMs: number
  private readonly maxSegmentDurationMs: number
  private readonly segmentMaxChars: number
  private readonly adjacencyGapLines: number
  private disposed = false

  constructor(
    private readonly context: vscode.ExtensionContext,
    appType: AppType
  ) {
    super(appType)
    const {
      segmentIdleMs,
      segmentMaxChars,
      minSegmentCharsWithNoWhitespace,
      adjacencyGapLines,
      maxSegmentDurationMs,
      uploadEnabled,
    } = HUMAN_TRACKING_CONFIG

    this.segmentIdleMs = segmentIdleMs
    this.segmentMaxChars = segmentMaxChars
    this.adjacencyGapLines = adjacencyGapLines
    this.maxSegmentDurationMs = maxSegmentDurationMs
    this.recorder = new HumanRecorder({
      uploadEnabled,
      minSegmentCharsWithNoWhitespace,
      appType: this.appType,
    })
  }

  async start(): Promise<void> {
    if (this._isRunning) {
      logger.info(`${this.name} is already running`)
      return
    }

    logger.info(`Starting ${this.name}`)

    try {
      const { segmentIdleMs, segmentMaxChars, uploadEnabled } =
        HUMAN_TRACKING_CONFIG
      // Config banner for visibility
      logger.info(
        `Human Code: started! uploadEnabled=${uploadEnabled} ` +
          `segmentIdleMs=${segmentIdleMs} ` +
          `segmentMaxChars=${segmentMaxChars}`
      )

      const editSub = vscode.workspace.onDidChangeTextDocument(
        async (event: vscode.TextDocumentChangeEvent) => {
          await this.onDidChangeTextDocument(event)
        }
      )
      this.subscriptions.push(editSub)

      const closeSub = vscode.workspace.onDidCloseTextDocument(
        async (closedDocument: vscode.TextDocument) => {
          try {
            const { uri } = closedDocument
            const documentUri = uri.toString()
            logger.info(`Human Code: document closed event for ${documentUri}`)
            const closedSegments =
              this.segmenter.onDidCloseTextDocument(documentUri)
            void this.handleClosedSegments(closedSegments)
          } catch (err) {
            logger.error({ err }, 'Human Code document close handling error')
          }
        }
      )
      this.subscriptions.push(closeSub)

      this._isRunning = true
      logger.info(`${this.name} started successfully`)
    } catch (err) {
      logger.error({ err }, `Failed to start ${this.name}`)
      this._isRunning = false
      throw err
    }
  }

  async stop(): Promise<void> {
    if (!this._isRunning) {
      return
    }

    logger.info(`Stopping ${this.name}`)

    // Best-effort flush of any remaining open segments.
    void this.flushAllOpenSegmentsOnShutdown()

    for (const subscription of this.subscriptions.splice(0)) {
      subscription.dispose()
    }
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer)
    }
    this.idleTimers.clear()

    this._isRunning = false
    logger.info(`${this.name} stopped`)
  }

  private async handleClosedSegments(segments: Segment[]): Promise<void> {
    for (const segment of segments) {
      logger.info('Human Code: segment closed due to manual flush')
      await this.classifyAndRecord(segment)
      // Clear any idle timer
      const existingTimer = this.idleTimers.get(segment.documentUri)
      if (existingTimer) {
        clearTimeout(existingTimer)
        this.idleTimers.delete(segment.documentUri)
      }
    }
  }

  private async onDidChangeTextDocument(
    event: vscode.TextDocumentChangeEvent
  ): Promise<void> {
    try {
      // Filter: only user-editable docs
      const currentDocument = event.document
      const { uri } = currentDocument
      if (!uri) {
        return
      }
      const { scheme } = uri
      if (!allowedSchemeSet.has(scheme)) {
        return
      }
      // Only track active editor (avoid background edits)
      const activeDoc = vscode.window.activeTextEditor?.document
      if (!activeDoc || activeDoc.uri.toString() !== uri.toString()) {
        return
      }
      // Detect human vs non-human edit shape
      const detection = detectEventClassification(event)
      logger.info(
        `Human Code: event classified eventType=${detection.eventClassification} ` +
          `changes=${detection.changeCount} firstInsertSize=${detection.firstInsertSize}`
      )
      // Process through segmenter: human events extend segments; non-human events only close current segments.
      const closedSegments = this.segmenter.onDidChangeTextDocument(event, {
        now: Date.now(),
        maxSegmentDurationMs: this.maxSegmentDurationMs,
        maxSegmentChars: this.segmentMaxChars,
        eventClassification: detection.eventClassification,
        adjacencyGapLines: this.adjacencyGapLines,
      })

      void this.handleClosedSegments(closedSegments)

      // Schedule idle flush timer
      this.scheduleIdleFlush(currentDocument)
    } catch (err) {
      // Local log for developer visibility and Datadog error for debugging
      logger.error({ err }, 'Human Code: error')
    }
  }

  private scheduleIdleFlush(currentDocument: vscode.TextDocument): void {
    const { uri, fileName } = currentDocument
    const documentUri = uri.toString()
    const relativePath = vscode.workspace.asRelativePath(fileName, false)
    const existingTimer = this.idleTimers.get(documentUri)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }
    const idleTimeout = setTimeout(
      async () => {
        try {
          logger.info(
            `Human Code: idle flush fired (no edits within ${this.segmentIdleMs}ms) for document ${relativePath}`
          )
          void this.closeByDocURIAndRecord(documentUri)
        } catch (err) {
          logger.error({ err }, 'Human Code idle flush error')
        } finally {
          this.idleTimers.delete(documentUri)
        }
      },
      Math.max(200, this.segmentIdleMs)
    )

    this.idleTimers.set(documentUri, idleTimeout)

    if (!existingTimer) {
      logger.info(
        `Human Code: idle flush scheduled in ${this.segmentIdleMs}ms for document ${relativePath}`
      )
    }
  }

  /** Classifies segment and forwards to recorder. */
  private async classifyAndRecord(segment: Segment): Promise<void> {
    const classification = await classifySegment(segment)
    const filePath = vscode.workspace.asRelativePath(segment.fileName, false)
    logger.info(
      `Human Code: ` +
        `segmentClassification=${classification} ` +
        `lines=${segment.rangeEndLineExclusive - segment.rangeStartLine} ` +
        `spanLines=[${segment.rangeStartLine}..${segment.rangeEndLineExclusive}] ` +
        `file=${filePath}`
    )
    if (!isSegmentHuman(classification)) {
      return
    }
    await this.recorder.record(segment, classification)
  }

  private async closeByDocURIAndRecord(documentUri: string): Promise<void> {
    const closedSegment = this.segmenter.closeSegmentByDocURI(documentUri)
    if (closedSegment) {
      await this.handleClosedSegments([closedSegment])
    } else {
      logger.info('Human Code: no segment to force-close')
    }
  }

  private async flushAllOpenSegmentsOnShutdown(): Promise<void> {
    // Best-effort flush of any remaining open segments when the extension is being torn down.
    const segmentsURIs = this.segmenter.getAllOpenSegmentsURIs()
    for (const uri of segmentsURIs) {
      const closedSegment = this.segmenter.closeSegmentByDocURI(uri.toString())
      if (closedSegment) {
        await this.handleClosedSegments([closedSegment])
      }
    }
  }
}
