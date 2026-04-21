/**
 * Worker thread for context file sanitization and skill zipping.
 * Runs off the extension host's main thread to avoid freezes during
 * CPU-intensive sanitize + adm-zip operations.
 */

import { parentPort } from 'node:worker_threads'

import { processContextFiles } from '../mobbdev_src/features/analysis/context_file_processor'
import type {
  SerializedSkill,
  WorkerRequest,
  WorkerResponse,
} from './contextFileWorkerTypes'

process.on('unhandledRejection', (reason) => {
  try {
    parentPort?.postMessage({
      id: -1,
      error: `Unhandled rejection in context file worker: ${reason}`,
    } satisfies WorkerResponse)
  } catch {
    // Last resort
  }
})

parentPort?.on('message', async (request: WorkerRequest) => {
  const { id, files, skillGroups } = request
  try {
    const { files: processedFiles, skills: processedSkills } =
      await processContextFiles(files, skillGroups)

    // Transfer zip buffers via postMessage transferList to avoid structured-clone overhead.
    // The .slice() creates a standalone ArrayBuffer copy first (Buffer may share a larger
    // pooled backing store, so a slice is required before transferring ownership).
    const transferList: ArrayBuffer[] = []
    const serializedSkills: SerializedSkill[] = processedSkills.map((s) => {
      // Extract a standalone ArrayBuffer so it can be transferred without structured-clone
      const ab = s.zipBuffer.buffer.slice(
        s.zipBuffer.byteOffset,
        s.zipBuffer.byteOffset + s.zipBuffer.byteLength
      ) as ArrayBuffer
      transferList.push(ab)
      return { ...s, zipBuffer: ab }
    })

    parentPort?.postMessage(
      {
        id,
        result: { files: processedFiles, skills: serializedSkills },
      } satisfies WorkerResponse,
      transferList
    )
  } catch (err) {
    parentPort?.postMessage({
      id,
      error: err instanceof Error ? err.message : String(err),
    } satisfies WorkerResponse)
  }
})
