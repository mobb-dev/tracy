import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Import under test (after mocks are registered)
// ---------------------------------------------------------------------------
import { ContextFileWorkerClient } from '../src/shared/contextFileWorkerClient'

// ---------------------------------------------------------------------------
// Mock node:worker_threads so tests never spawn real threads
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => {
  // Minimal EventEmitter-style Worker mock
  class MockWorker {
    static instances: MockWorker[] = []
    handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
    terminated = false

    constructor() {
      MockWorker.instances.push(this)
    }

    on(event: string, fn: (...args: unknown[]) => void) {
      if (!this.handlers[event]) {
        this.handlers[event] = []
      }
      this.handlers[event].push(fn)
      return this
    }

    emit(event: string, ...args: unknown[]) {
      for (const fn of this.handlers[event] ?? []) {
        fn(...args)
      }
    }

    postMessage(msg: unknown) {
      mocks.postMessage(msg)
    }

    terminate() {
      this.terminated = true
    }
  }

  return {
    MockWorker,
    postMessage: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }
})

vi.mock('node:worker_threads', () => ({
  Worker: mocks.MockWorker,
}))

vi.mock('../src/shared/logger', () => ({
  logger: mocks.logger,
}))

// Silence module resolution noise for the worker file path resolution
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>()
  return {
    ...actual,
    join: (...args: string[]) => args.join('/'),
  }
})

function latestWorker(): InstanceType<typeof mocks.MockWorker> {
  const w = mocks.MockWorker.instances.at(-1)
  if (!w) {
    throw new Error('No MockWorker instance')
  }
  return w
}

function replyToRequest(id: number, result: object) {
  latestWorker().emit('message', { id, result })
}

function replyWithError(id: number, error: string) {
  latestWorker().emit('message', { id, error })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.MockWorker.instances.length = 0
})

describe('ContextFileWorkerClient — request dispatch', () => {
  it('sends a postMessage and resolves with the processed result', async () => {
    const client = new ContextFileWorkerClient()

    const expected = {
      files: [
        { entry: {}, sanitizedContent: 'hello', md5: 'abc', sizeBytes: 5 },
      ],
      skills: [],
    }

    // Trigger the reply after the postMessage is sent
    mocks.postMessage.mockImplementationOnce((msg: { id: number }) => {
      setImmediate(() => replyToRequest(msg.id, expected))
    })

    const result = await client.process([], [])

    expect(result.files).toEqual(expected.files)
    expect(result.skills).toEqual([])
    client.dispose()
  })

  it('rejects when the worker returns an error response', async () => {
    const client = new ContextFileWorkerClient()

    mocks.postMessage.mockImplementationOnce((msg: { id: number }) => {
      setImmediate(() => replyWithError(msg.id, 'processing failed'))
    })

    await expect(client.process([], [])).rejects.toThrow('processing failed')
    client.dispose()
  })

  it('reconstructs ProcessedSkill.zipBuffer from transferred ArrayBuffer', async () => {
    const client = new ContextFileWorkerClient()
    const ab = new ArrayBuffer(4)
    new Uint8Array(ab).set([0x50, 0x4b, 0x03, 0x04])

    mocks.postMessage.mockImplementationOnce((msg: { id: number }) => {
      setImmediate(() =>
        replyToRequest(msg.id, {
          files: [],
          skills: [
            {
              group: {},
              zipBuffer: ab,
              md5: 'zipmd5',
              sizeBytes: 4,
              name: 'my-skill',
            },
          ],
        })
      )
    })

    const { skills } = await client.process([], [])
    expect(skills).toHaveLength(1)
    expect(Buffer.isBuffer(skills[0]!.zipBuffer)).toBe(true)
    expect(skills[0]!.zipBuffer.subarray(0, 4).toString('hex')).toBe('504b0304')
    client.dispose()
  })
})

describe('ContextFileWorkerClient — timeout', () => {
  it('rejects after WORKER_TIMEOUT_MS with no reply', async () => {
    vi.useFakeTimers()
    const client = new ContextFileWorkerClient()

    const promise = client.process([], [])
    // Attach the catch handler BEFORE advancing fake timers so the rejection
    // is handled immediately when the timer fires (prevents unhandled-rejection)
    const caught = promise.catch((e: Error) => e)

    await vi.advanceTimersByTimeAsync(61_000)

    const err = await caught
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/timed out/)

    vi.useRealTimers()
    client.dispose()
  })
})

describe('ContextFileWorkerClient — error & restart', () => {
  it('rejects pending requests when worker emits an error', async () => {
    const client = new ContextFileWorkerClient()
    const promise = client.process([], [])

    latestWorker().emit('error', new Error('worker crash'))

    await expect(promise).rejects.toThrow('worker crash')
    client.dispose()
  })

  it('rejects pending requests when worker exits with non-zero code', async () => {
    const client = new ContextFileWorkerClient()
    const promise = client.process([], [])

    latestWorker().emit('exit', 1)

    await expect(promise).rejects.toThrow()
    client.dispose()
  })

  it('does not restart after dispose', async () => {
    vi.useFakeTimers()
    const client = new ContextFileWorkerClient()
    client.dispose()

    const countBefore = mocks.MockWorker.instances.length
    latestWorker().emit('error', new Error('crash'))
    await vi.advanceTimersByTimeAsync(5_000)

    expect(mocks.MockWorker.instances.length).toBe(countBefore)
    vi.useRealTimers()
  })
})

describe('ContextFileWorkerClient — dispose', () => {
  it('rejects all pending requests on dispose', async () => {
    const client = new ContextFileWorkerClient()
    // Queue two requests without replies
    const p1 = client.process([], [])
    const p2 = client.process([], [])

    client.dispose()

    await expect(p1).rejects.toThrow('disposed')
    await expect(p2).rejects.toThrow('disposed')
  })

  it('terminates the underlying Worker on dispose', () => {
    const client = new ContextFileWorkerClient()
    const w = latestWorker()
    expect(w.terminated).toBe(false)
    client.dispose()
    expect(w.terminated).toBe(true)
  })
})
