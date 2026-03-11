import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks — must be set up before vi.mock() factory calls run.
// vi.hoisted() values are available inside vi.mock() factories.
// ---------------------------------------------------------------------------
const {
  controllerInstances,
  MockTracyController,
  MockGitBlameCache,
  MockAIBlameCache,
} = vi.hoisted(() => {
  const controllerInstances: {
    isFileInRepo: ReturnType<typeof vi.fn>
    handleEditorChange: ReturnType<typeof vi.fn>
    handleSelectionChange: ReturnType<typeof vi.fn>
    invalidate: ReturnType<typeof vi.fn>
    showInfoPanel: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    _gitRoot: string
  }[] = []

  const MockTracyController = vi
    .fn()
    .mockImplementation(
      (
        _gc: unknown,
        _ac: unknown,
        _view: unknown,
        _url: string,
        gitRoot: string
      ) => {
        const inst = {
          _gitRoot: gitRoot,
          isFileInRepo: vi.fn(
            (fp: string) =>
              !gitRoot || fp === gitRoot || fp.startsWith(`${gitRoot}/`)
          ),
          handleEditorChange: vi.fn().mockResolvedValue(undefined),
          handleSelectionChange: vi.fn(),
          invalidate: vi.fn(),
          showInfoPanel: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
        }
        controllerInstances.push(inst)
        return inst
      }
    )

  const MockGitBlameCache = vi
    .fn()
    .mockImplementation(() => ({ dispose: vi.fn() }))
  const MockAIBlameCache = vi
    .fn()
    .mockImplementation(() => ({ dispose: vi.fn() }))

  return {
    controllerInstances,
    MockTracyController,
    MockGitBlameCache,
    MockAIBlameCache,
  }
})

// ---------------------------------------------------------------------------
// VS Code event handler capture — populated when coordinator is constructed.
// ---------------------------------------------------------------------------
let capturedEditorChangeHandler: ((e: unknown) => Promise<void>) | undefined
let capturedSelectionHandler: ((e: unknown) => void) | undefined
let capturedCommandHandler: (() => Promise<void>) | undefined

const mockDisposable = { dispose: vi.fn() }

const mockVSCode = {
  window: {
    activeTextEditor: undefined as unknown,
    visibleTextEditors: [] as unknown[],
    onDidChangeActiveTextEditor: vi.fn((cb: (e: unknown) => Promise<void>) => {
      capturedEditorChangeHandler = cb
      return mockDisposable
    }),
    onDidChangeTextEditorSelection: vi.fn((cb: (e: unknown) => void) => {
      capturedSelectionHandler = cb
      return mockDisposable
    }),
  },
  commands: {
    registerCommand: vi.fn((_name: string, cb: () => Promise<void>) => {
      capturedCommandHandler = cb
      return mockDisposable
    }),
  },
}

vi.mock('vscode', () => mockVSCode)
vi.mock('../src/ui/TracyController', () => ({
  TracyController: MockTracyController,
}))
vi.mock('../src/ui/GitBlameCache', () => ({
  GitBlameCache: MockGitBlameCache,
}))
vi.mock('../src/ui/AIBlameCache', () => ({
  AIBlameCache: MockAIBlameCache,
}))
vi.mock('../env', () => ({ EXTENSION_NAME: 'mobb-tracer' }))
vi.mock('../src/shared/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------
const REPO_A = {
  gitRepoUrl: 'https://github.com/org/repo-a',
  gitRoot: '/workspace/repo-a',
}
const REPO_B = {
  gitRepoUrl: 'https://github.com/org/repo-b',
  gitRoot: '/workspace/repo-b',
}
const ORG_ID = 'org-123'

function makeView() {
  return { refresh: vi.fn(), error: vi.fn() }
}

function makeEditor(fsPath: string, scheme = 'file') {
  return { document: { uri: { scheme, fsPath } } }
}

function makeSelectionEvent(fsPath: string, scheme = 'file') {
  return {
    textEditor: { document: { uri: { scheme, fsPath } } },
    selections: [{}],
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('TracyCoordinator', () => {
  beforeEach(() => {
    // Clear all captured state before each test.
    capturedEditorChangeHandler = undefined
    capturedSelectionHandler = undefined
    capturedCommandHandler = undefined
    controllerInstances.length = 0
    mockVSCode.window.activeTextEditor = undefined
    mockVSCode.window.visibleTextEditors = []

    // Re-apply implementations so they keep capturing handlers even after
    // vi.resetAllMocks() has cleared them from the previous test.
    mockVSCode.window.onDidChangeActiveTextEditor.mockImplementation(
      (cb: (e: unknown) => Promise<void>) => {
        capturedEditorChangeHandler = cb
        return mockDisposable
      }
    )
    mockVSCode.window.onDidChangeTextEditorSelection.mockImplementation(
      (cb: (e: unknown) => void) => {
        capturedSelectionHandler = cb
        return mockDisposable
      }
    )
    mockVSCode.commands.registerCommand.mockImplementation(
      (_name: string, cb: () => Promise<void>) => {
        capturedCommandHandler = cb
        return mockDisposable
      }
    )
  })

  afterEach(() => {
    // clearAllMocks resets call history but preserves mockImplementation so
    // MockTracyController (and friends) keep functioning across tests.
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  describe('construction', () => {
    it('creates one TracyController per repository', async () => {
      const { TracyCoordinator } = await import('../src/ui/TracyCoordinator')
      new TracyCoordinator([REPO_A, REPO_B], ORG_ID, makeView())
      expect(MockTracyController).toHaveBeenCalledTimes(2)
    })

    it('registers exactly one showInfoPanel command regardless of repo count', async () => {
      const { TracyCoordinator } = await import('../src/ui/TracyCoordinator')
      new TracyCoordinator([REPO_A, REPO_B], ORG_ID, makeView())
      expect(mockVSCode.commands.registerCommand).toHaveBeenCalledTimes(1)
    })

    it('registers exactly one active-editor listener', async () => {
      const { TracyCoordinator } = await import('../src/ui/TracyCoordinator')
      new TracyCoordinator([REPO_A, REPO_B], ORG_ID, makeView())
      expect(
        mockVSCode.window.onDidChangeActiveTextEditor
      ).toHaveBeenCalledTimes(1)
    })

    it('registers exactly one selection-change listener', async () => {
      const { TracyCoordinator } = await import('../src/ui/TracyCoordinator')
      new TracyCoordinator([REPO_A, REPO_B], ORG_ID, makeView())
      expect(
        mockVSCode.window.onDidChangeTextEditorSelection
      ).toHaveBeenCalledTimes(1)
    })

    it('immediately handles an already-active editor on load', async () => {
      mockVSCode.window.activeTextEditor = makeEditor(
        '/workspace/repo-a/src/index.ts'
      )
      const { TracyCoordinator } = await import('../src/ui/TracyCoordinator')
      new TracyCoordinator([REPO_A], ORG_ID, makeView())

      // Give the fire-and-forget void promise a tick to settle.
      await new Promise((r) => setTimeout(r, 0))

      expect(controllerInstances[0].handleEditorChange).toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  describe('onActiveEditorChange routing', () => {
    it('routes a file inside repo-a to the first controller', async () => {
      const { TracyCoordinator } = await import('../src/ui/TracyCoordinator')
      new TracyCoordinator([REPO_A, REPO_B], ORG_ID, makeView())

      const editor = makeEditor('/workspace/repo-a/src/index.ts')
      await capturedEditorChangeHandler!(editor)

      expect(controllerInstances[0].handleEditorChange).toHaveBeenCalledWith(
        editor
      )
      expect(controllerInstances[1].handleEditorChange).not.toHaveBeenCalled()
    })

    it('routes a file inside repo-b to the second controller', async () => {
      const { TracyCoordinator } = await import('../src/ui/TracyCoordinator')
      new TracyCoordinator([REPO_A, REPO_B], ORG_ID, makeView())

      const editor = makeEditor('/workspace/repo-b/lib/utils.ts')
      await capturedEditorChangeHandler!(editor)

      expect(controllerInstances[1].handleEditorChange).toHaveBeenCalledWith(
        editor
      )
      expect(controllerInstances[0].handleEditorChange).not.toHaveBeenCalled()
    })

    it('calls view.refresh(OUTSIDE_REPO) when file is not in any repo', async () => {
      const { TracyCoordinator } = await import('../src/ui/TracyCoordinator')
      const { LineState } = await import('../src/ui/TracyStatusBar')
      const view = makeView()
      new TracyCoordinator([REPO_A, REPO_B], ORG_ID, view)

      await capturedEditorChangeHandler!(
        makeEditor('/unrelated/project/file.ts')
      )

      expect(view.refresh).toHaveBeenCalledWith(LineState.OUTSIDE_REPO)
      expect(controllerInstances[0].handleEditorChange).not.toHaveBeenCalled()
      expect(controllerInstances[1].handleEditorChange).not.toHaveBeenCalled()
    })

    it('invalidates the previous controller when switching from repo-a to repo-b', async () => {
      const { TracyCoordinator } = await import('../src/ui/TracyCoordinator')
      new TracyCoordinator([REPO_A, REPO_B], ORG_ID, makeView())
      const [ctrlA, ctrlB] = controllerInstances

      await capturedEditorChangeHandler!(
        makeEditor('/workspace/repo-a/src/a.ts')
      )
      expect(ctrlA.invalidate).not.toHaveBeenCalled()

      await capturedEditorChangeHandler!(
        makeEditor('/workspace/repo-b/src/b.ts')
      )

      expect(ctrlA.invalidate).toHaveBeenCalled()
      expect(ctrlB.handleEditorChange).toHaveBeenCalled()
    })

    it('invalidates active controller when moving to a file outside all repos', async () => {
      const { TracyCoordinator } = await import('../src/ui/TracyCoordinator')
      new TracyCoordinator([REPO_A, REPO_B], ORG_ID, makeView())
      const [ctrlA] = controllerInstances

      await capturedEditorChangeHandler!(
        makeEditor('/workspace/repo-a/src/a.ts')
      )
      await capturedEditorChangeHandler!(makeEditor('/unrelated/file.ts'))

      expect(ctrlA.invalidate).toHaveBeenCalled()
    })

    it('ignores non-file URI schemes (e.g. output panels)', async () => {
      const { TracyCoordinator } = await import('../src/ui/TracyCoordinator')
      new TracyCoordinator([REPO_A, REPO_B], ORG_ID, makeView())

      await capturedEditorChangeHandler!(makeEditor('', 'output'))

      expect(controllerInstances[0].handleEditorChange).not.toHaveBeenCalled()
      expect(controllerInstances[1].handleEditorChange).not.toHaveBeenCalled()
    })

    it('clears state when no visible editors remain (all truly closed)', async () => {
      const { TracyCoordinator } = await import('../src/ui/TracyCoordinator')
      const { LineState } = await import('../src/ui/TracyStatusBar')
      const view = makeView()
      new TracyCoordinator([REPO_A, REPO_B], ORG_ID, view)
      const [ctrlA] = controllerInstances

      // First, activate an editor to establish state
      await capturedEditorChangeHandler!(
        makeEditor('/workspace/repo-a/src/a.ts')
      )

      // Now simulate all editors being closed (no visible editors)
      mockVSCode.window.visibleTextEditors = []
      await capturedEditorChangeHandler!(undefined)

      expect(ctrlA.invalidate).toHaveBeenCalled()
      expect(view.refresh).toHaveBeenCalledWith(
        LineState.NO_FILE_SELECTED_ERROR
      )
    })

    it('maintains state when active editor is undefined but visible editors remain (e.g. web view opened)', async () => {
      const { TracyCoordinator } = await import('../src/ui/TracyCoordinator')
      const view = makeView()
      new TracyCoordinator([REPO_A, REPO_B], ORG_ID, view)
      const [ctrlA] = controllerInstances

      // First, activate an editor to establish state
      await capturedEditorChangeHandler!(
        makeEditor('/workspace/repo-a/src/a.ts')
      )

      // Simulate opening web view (activeTextEditor becomes undefined but editor still visible)
      mockVSCode.window.visibleTextEditors = [
        makeEditor('/workspace/repo-a/src/a.ts'),
      ]
      await capturedEditorChangeHandler!(undefined)

      // Should NOT invalidate or clear state
      expect(ctrlA.invalidate).not.toHaveBeenCalled()
      expect(view.refresh).not.toHaveBeenCalledWith(expect.anything())
    })
  })

  // -------------------------------------------------------------------------
  describe('onSelectionChange routing', () => {
    it('routes a selection event in repo-a to the first controller', async () => {
      const { TracyCoordinator } = await import('../src/ui/TracyCoordinator')
      new TracyCoordinator([REPO_A, REPO_B], ORG_ID, makeView())

      const event = makeSelectionEvent('/workspace/repo-a/src/a.ts')
      capturedSelectionHandler!(event)

      expect(controllerInstances[0].handleSelectionChange).toHaveBeenCalledWith(
        event
      )
      expect(
        controllerInstances[1].handleSelectionChange
      ).not.toHaveBeenCalled()
    })

    it('does not forward selection for a file outside all repos', async () => {
      const { TracyCoordinator } = await import('../src/ui/TracyCoordinator')
      new TracyCoordinator([REPO_A, REPO_B], ORG_ID, makeView())

      capturedSelectionHandler!(makeSelectionEvent('/unrelated/file.ts'))

      expect(
        controllerInstances[0].handleSelectionChange
      ).not.toHaveBeenCalled()
      expect(
        controllerInstances[1].handleSelectionChange
      ).not.toHaveBeenCalled()
    })

    it('ignores non-file URI schemes', async () => {
      const { TracyCoordinator } = await import('../src/ui/TracyCoordinator')
      new TracyCoordinator([REPO_A, REPO_B], ORG_ID, makeView())

      capturedSelectionHandler!(makeSelectionEvent('', 'output'))

      expect(
        controllerInstances[0].handleSelectionChange
      ).not.toHaveBeenCalled()
      expect(
        controllerInstances[1].handleSelectionChange
      ).not.toHaveBeenCalled()
    })

    it('ignores events with an empty selections array', async () => {
      const { TracyCoordinator } = await import('../src/ui/TracyCoordinator')
      new TracyCoordinator([REPO_A, REPO_B], ORG_ID, makeView())

      capturedSelectionHandler!({
        textEditor: {
          document: {
            uri: { scheme: 'file', fsPath: '/workspace/repo-a/a.ts' },
          },
        },
        selections: [],
      })

      expect(
        controllerInstances[0].handleSelectionChange
      ).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  describe('showInfoPanel command', () => {
    it('logs a warning when no file has been activated yet', async () => {
      const { TracyCoordinator } = await import('../src/ui/TracyCoordinator')
      const { logger } = await import('../src/shared/logger')
      new TracyCoordinator([REPO_A, REPO_B], ORG_ID, makeView())

      await capturedCommandHandler!()

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('no active controller')
      )
    })

    it('delegates showInfoPanel to the active controller', async () => {
      const { TracyCoordinator } = await import('../src/ui/TracyCoordinator')
      new TracyCoordinator([REPO_A, REPO_B], ORG_ID, makeView())
      const [ctrlA] = controllerInstances

      await capturedEditorChangeHandler!(
        makeEditor('/workspace/repo-a/src/a.ts')
      )
      await capturedCommandHandler!()

      expect(ctrlA.showInfoPanel).toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  describe('dispose', () => {
    it('disposes all controllers', async () => {
      const { TracyCoordinator } = await import('../src/ui/TracyCoordinator')
      const coordinator = new TracyCoordinator(
        [REPO_A, REPO_B],
        ORG_ID,
        makeView()
      )
      const [ctrlA, ctrlB] = controllerInstances

      coordinator.dispose()

      expect(ctrlA.dispose).toHaveBeenCalled()
      expect(ctrlB.dispose).toHaveBeenCalled()
    })

    it('disposes its own VS Code listeners', async () => {
      const { TracyCoordinator } = await import('../src/ui/TracyCoordinator')
      const coordinator = new TracyCoordinator(
        [REPO_A, REPO_B],
        ORG_ID,
        makeView()
      )

      coordinator.dispose()

      // mockDisposable.dispose is called once for each of the 3 listeners
      // (onDidChangeTextEditorSelection, onDidChangeActiveTextEditor, registerCommand).
      expect(mockDisposable.dispose).toHaveBeenCalledTimes(3)
    })
  })
})
