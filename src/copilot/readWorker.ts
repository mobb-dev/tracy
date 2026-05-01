/**
 * Worker thread for Copilot JSONL file reads.
 *
 * Moves the three synchronous hot spots off the extension host main thread:
 *   1. `buffer.toString('utf-8')` on multi-MB buffers
 *   2. `text.split('\n')` on the same
 *   3. Line filtering and byte-offset math
 *
 * Without this worker, a first-run catch-up with 40+ historical session
 * files blocked the extension host for ~18s and spiked heap by ~180MB in
 * a single poll cycle (observed in B3 stress test, 2026-04-15).
 *
 * Reading happens sequentially across files *inside* the worker to bound
 * peak memory — the main thread submits one batched request, stays
 * responsive while the worker pays the CPU cost, and gets back
 * already-split lines.
 */

import * as fs from 'node:fs/promises'
import { parentPort } from 'node:worker_threads'

const MAX_READ_BYTES = 20 * 1024 * 1024 // 20 MB

type ReadRequest = {
  id: number
  files: Array<{ path: string; byteOffset: number }>
}

type PerFileResult = {
  path: string
  lines: string[]
  newByteOffset: number
  newFileSize: number
  truncated: boolean
  /** Null when the file read failed entirely (e.g. deleted, permission). */
  error: string | null
}

type ReadResponse = {
  id: number
  result?: PerFileResult[]
  error?: string
  perf?: {
    queryDurationMs: number
    heapUsedBytes: number
    rssBytes: number
    totalCharsRead: number
    filesRead: number
  }
}

process.on('unhandledRejection', (reason) => {
  try {
    parentPort?.postMessage({
      id: -1,
      error: `Unhandled rejection in Copilot read worker: ${reason}`,
    })
  } catch {
    // Nothing we can do
  }
})

async function readOne(
  filePath: string,
  byteOffset: number
): Promise<PerFileResult> {
  try {
    const stat = await fs.stat(filePath)
    const currentSize = stat.size

    // Handle truncation: offset past EOF → reset to 0
    const effectiveOffset = byteOffset > currentSize ? 0 : byteOffset

    if (effectiveOffset >= currentSize) {
      return {
        path: filePath,
        lines: [],
        newByteOffset: effectiveOffset,
        newFileSize: currentSize,
        truncated: false,
        error: null,
      }
    }

    const bytesToRead = currentSize - effectiveOffset
    const cappedBytes = Math.min(bytesToRead, MAX_READ_BYTES)
    const truncated = cappedBytes < bytesToRead

    const fh = await fs.open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(cappedBytes)
      const { bytesRead } = await fh.read(
        buffer,
        0,
        cappedBytes,
        effectiveOffset
      )
      // Use bytesRead (not cappedBytes) to handle the case where the file
      // was truncated between stat() and read() — avoids trailing zero bytes.
      const text = buffer.subarray(0, bytesRead).toString('utf-8')

      // Compute byte offset from the RAW text before any line filtering.
      // Previously, offset was computed from filtered lines (blank lines
      // removed), causing drift when files contained blank lines — flagged
      // by all 8 review agents.
      let consumedText: string
      if (truncated && !text.endsWith('\n')) {
        // Drop everything after the last complete newline
        const lastNewline = text.lastIndexOf('\n')
        consumedText =
          lastNewline >= 0 ? text.substring(0, lastNewline + 1) : ''
      } else {
        consumedText = text
      }
      const newByteOffset = truncated
        ? effectiveOffset + Buffer.byteLength(consumedText, 'utf-8')
        : currentSize

      // Filter empty lines only for the returned array — does NOT affect offset
      const lines = consumedText.split('\n').filter((l) => l.trim().length > 0)

      return {
        path: filePath,
        lines,
        newByteOffset,
        newFileSize: currentSize,
        truncated,
        error: null,
      }
    } finally {
      await fh.close()
    }
  } catch (err) {
    return {
      path: filePath,
      lines: [],
      newByteOffset: byteOffset,
      newFileSize: 0,
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

parentPort?.on('message', async (msg: ReadRequest) => {
  const { id, files } = msg
  const queryStart = Date.now()
  let response: ReadResponse

  try {
    // Process files sequentially to bound peak memory — up to 10 files x
    // 20MB each could spike to ~200MB if read in parallel via Promise.all.
    const result: PerFileResult[] = []
    for (const { path: p, byteOffset } of files) {
      result.push(await readOne(p, byteOffset))
    }
    const totalCharsRead = result.reduce(
      (sum, r) => sum + r.lines.reduce((s, l) => s + l.length, 0),
      0
    )
    const mem = process.memoryUsage()
    response = {
      id,
      result,
      perf: {
        queryDurationMs: Date.now() - queryStart,
        heapUsedBytes: mem.heapUsed,
        rssBytes: mem.rss,
        totalCharsRead,
        filesRead: files.length,
      },
    }
  } catch (err) {
    response = {
      id,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  parentPort?.postMessage(response)
})
