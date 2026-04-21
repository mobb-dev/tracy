/**
 * Shared message protocol types for the context file worker thread.
 * Imported by both contextFileWorker.ts and contextFileWorkerClient.ts to
 * avoid duplicate type definitions that can drift out of sync.
 */

import type {
  ProcessedFile,
  ProcessedSkill,
} from '../mobbdev_src/features/analysis/context_file_processor'

/**
 * Skill serialized for postMessage transfer.
 * zipBuffer is sent as a transferable ArrayBuffer (zero-copy) rather than a
 * number array to avoid the O(n) Array.from clone for large skill zips.
 */
export type SerializedSkill = Omit<ProcessedSkill, 'zipBuffer'> & {
  zipBuffer: ArrayBuffer
}

export type WorkerRequest = {
  id: number
  files: import('../mobbdev_src/features/analysis/context_file_scanner').ContextFileEntry[]
  skillGroups: import('../mobbdev_src/features/analysis/context_file_scanner').SkillGroup[]
}

export type WorkerResponse = {
  id: number
  result?: {
    files: ProcessedFile[]
    skills: SerializedSkill[]
  }
  error?: string
}
