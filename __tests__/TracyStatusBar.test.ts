import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock vscode
const mockStatusBarItem = {
  text: '',
  command: '',
  tooltip: null,
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
}

const mockMarkdownString = vi.fn().mockImplementation((content) => ({
  value: content,
  isTrusted: false,
  supportHtml: false,
}))

const mockVSCode = {
  StatusBarAlignment: {
    Left: 1,
    Right: 2,
  },
  MarkdownString: mockMarkdownString,
}

vi.mock('vscode', () => mockVSCode)

// Mock env module with default production extension name
vi.mock('../src/env', () => ({
  EXTENSION_NAME: 'mobb-ai-tracer',
}))

describe('TracyStatusBar', () => {
  afterEach(() => {
    vi.resetAllMocks()
  })

  describe('state rendering', () => {
    it('renders loading state correctly', async () => {
      const { StatusBarView, LineState } = await import(
        '../src/ui/TracyStatusBar'
      )

      const view = new StatusBarView(mockStatusBarItem as any)
      view.refresh(LineState.LOADING)

      expect(mockStatusBarItem.text).toBe('Tracy: $(loading~spin)')
      expect(mockStatusBarItem.command).toBe('mobb-ai-tracer.showInfoPanel')
      expect(mockStatusBarItem.show).toHaveBeenCalled()
    })

    it('renders AI state correctly', async () => {
      const { StatusBarView, LineState } = await import(
        '../src/ui/TracyStatusBar'
      )

      const view = new StatusBarView(mockStatusBarItem as any)
      view.refresh(LineState.AI)

      expect(mockStatusBarItem.text).toBe('Tracy: $(robot)')
      expect(mockStatusBarItem.command).toBe('mobb-ai-tracer.showInfoPanel')
      expect(mockMarkdownString).toHaveBeenCalledWith(
        expect.stringContaining('Detected AI-generated code on this line')
      )
      expect(mockStatusBarItem.show).toHaveBeenCalled()
    })

    it('renders human state correctly', async () => {
      const { StatusBarView, LineState } = await import(
        '../src/ui/TracyStatusBar'
      )

      const view = new StatusBarView(mockStatusBarItem as any)
      view.refresh(LineState.HUMAN)

      expect(mockStatusBarItem.text).toBe('Tracy: $(person)')
      expect(mockMarkdownString).toHaveBeenCalledWith(
        expect.stringContaining('Detected human-written code on this line')
      )
      expect(mockStatusBarItem.show).toHaveBeenCalled()
    })

    it('renders no data state correctly', async () => {
      const { StatusBarView, LineState } = await import(
        '../src/ui/TracyStatusBar'
      )

      const view = new StatusBarView(mockStatusBarItem as any)
      view.refresh(LineState.NO_ATTRIBUTION_DATA)

      expect(mockStatusBarItem.text).toBe('Tracy: $(dash)')
      expect(mockMarkdownString).toHaveBeenCalledWith(
        expect.stringContaining('No AI attribution data for this line')
      )
      expect(mockStatusBarItem.show).toHaveBeenCalled()
    })

    it('renders error state correctly', async () => {
      const { StatusBarView, LineState } = await import(
        '../src/ui/TracyStatusBar'
      )

      const view = new StatusBarView(mockStatusBarItem as any)
      view.refresh(LineState.ATTRIBUTION_ERROR)

      expect(mockStatusBarItem.text).toBe('Tracy: $(error)')
      expect(mockStatusBarItem.command).toBe('mobb-ai-tracer.showInfoPanel')
      expect(mockStatusBarItem.show).toHaveBeenCalled()
    })

    it('renders no file selected error state correctly', async () => {
      const { StatusBarView, LineState } = await import(
        '../src/ui/TracyStatusBar'
      )

      const view = new StatusBarView(mockStatusBarItem as any)
      view.refresh(LineState.NO_FILE_SELECTED_ERROR)

      expect(mockStatusBarItem.text).toBe('Tracy: $(error)')
      expect(mockMarkdownString).toHaveBeenCalledWith(
        expect.stringContaining(
          'No file selected. Please open a file to get AI attribution data.'
        )
      )
      expect(mockStatusBarItem.show).toHaveBeenCalled()
    })

    it('handles unknown state gracefully', async () => {
      const { StatusBarView } = await import('../src/ui/TracyStatusBar')

      const view = new StatusBarView(mockStatusBarItem as any)
      view.refresh('unknown-state' as any)

      expect(mockStatusBarItem.text).toBe('Tracy: $(dash)')
      expect(mockStatusBarItem.command).toBe('mobb-ai-tracer.showInfoPanel')
      expect(mockStatusBarItem.show).toHaveBeenCalled()
    })
  })

  describe('error handling', () => {
    it('displays error message correctly', async () => {
      const { StatusBarView } = await import('../src/ui/TracyStatusBar')

      const view = new StatusBarView(mockStatusBarItem as any)
      const errorMessage = 'Network connection failed'

      view.error(errorMessage)

      expect(mockStatusBarItem.text).toBe('Tracy: $(error)')
      expect(mockMarkdownString).toHaveBeenCalledWith(
        expect.stringContaining(errorMessage)
      )
      expect(mockStatusBarItem.show).toHaveBeenCalled()
    })
  })

  describe('markdown generation', () => {
    it('generates proper markdown structure', async () => {
      const { StatusBarView, LineState } = await import(
        '../src/ui/TracyStatusBar'
      )

      const view = new StatusBarView(mockStatusBarItem as any)
      view.refresh(LineState.AI)

      // Check that markdown includes header and context
      const lastCall =
        mockMarkdownString.mock.calls[mockMarkdownString.mock.calls.length - 1]
      const markdownContent = lastCall[0]

      expect(markdownContent).toContain('## Mobb Tracy')
      expect(markdownContent).toContain('AI Code Attribution')
      expect(markdownContent).toContain('---')
      expect(markdownContent).toContain(
        'Detected AI-generated code on this line'
      )
    })

    it('generates markdown without context when none provided', async () => {
      const { StatusBarView, LineState } = await import(
        '../src/ui/TracyStatusBar'
      )

      const view = new StatusBarView(mockStatusBarItem as any)
      view.refresh(LineState.LOADING)

      const lastCall =
        mockMarkdownString.mock.calls[mockMarkdownString.mock.calls.length - 1]
      const markdownContent = lastCall[0]

      expect(markdownContent).toContain('## Mobb Tracy')
      expect(markdownContent).toContain('AI Code Attribution')
      // Should not contain separator when no context
      expect(markdownContent).not.toContain('---')
    })

    it('sets markdown properties correctly', async () => {
      const { StatusBarView, LineState } = await import(
        '../src/ui/TracyStatusBar'
      )

      const view = new StatusBarView(mockStatusBarItem as any)
      view.refresh(LineState.AI)

      // Check that the MarkdownString was configured properly
      const mockMarkdownInstance =
        mockMarkdownString.mock.results[
          mockMarkdownString.mock.results.length - 1
        ].value
      expect(mockMarkdownInstance.isTrusted).toBe(true)
      expect(mockMarkdownInstance.supportHtml).toBe(true)
    })
  })

  describe('initialization', () => {
    it('initializes status bar item correctly', async () => {
      const { StatusBarView } = await import('../src/ui/TracyStatusBar')

      new StatusBarView(mockStatusBarItem as any)

      expect(mockStatusBarItem.text).toBe('Tracy: $(error)')
      expect(mockStatusBarItem.command).toBe('mobb-ai-tracer.showInfoPanel')
      expect(mockStatusBarItem.show).toHaveBeenCalled()
    })
  })
})

describe('TracyStatusBar dev mode detection', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  it('shows DEV prefix when extension name ends with -dev', async () => {
    // Reset modules to clear cached imports
    vi.resetModules()

    // Re-mock vscode first
    vi.doMock('vscode', () => mockVSCode)

    // Re-mock with dev extension name
    vi.doMock('../src/env', () => ({
      EXTENSION_NAME: 'mobb-ai-tracer-dev',
    }))

    const { StatusBarView, LineState } = await import(
      '../src/ui/TracyStatusBar'
    )

    const view = new StatusBarView(mockStatusBarItem as any)
    view.refresh(LineState.AI)

    expect(mockStatusBarItem.text).toBe('Tracy (DEV): $(robot)')
    expect(mockStatusBarItem.command).toBe('mobb-ai-tracer-dev.showInfoPanel')
  })

  it('shows normal prefix when extension name does not end with -dev', async () => {
    // Reset modules to clear cached imports
    vi.resetModules()

    // Re-mock vscode first
    vi.doMock('vscode', () => mockVSCode)

    // Re-mock with production extension name
    vi.doMock('../src/env', () => ({
      EXTENSION_NAME: 'mobb-ai-tracer',
    }))

    const { StatusBarView, LineState } = await import(
      '../src/ui/TracyStatusBar'
    )

    const view = new StatusBarView(mockStatusBarItem as any)
    view.refresh(LineState.AI)

    expect(mockStatusBarItem.text).toBe('Tracy: $(robot)')
    expect(mockStatusBarItem.command).toBe('mobb-ai-tracer.showInfoPanel')
  })

  it('initializes with DEV prefix in dev mode', async () => {
    // Reset modules to clear cached imports
    vi.resetModules()

    // Re-mock vscode first
    vi.doMock('vscode', () => mockVSCode)

    vi.doMock('../src/env', () => ({
      EXTENSION_NAME: 'mobb-ai-tracer-dev',
    }))

    const { StatusBarView } = await import('../src/ui/TracyStatusBar')

    new StatusBarView(mockStatusBarItem as any)

    expect(mockStatusBarItem.text).toBe('Tracy (DEV): $(error)')
    expect(mockStatusBarItem.command).toBe('mobb-ai-tracer-dev.showInfoPanel')
  })
})
