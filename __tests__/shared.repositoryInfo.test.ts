import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('detectAppType', () => {
  const mockVSCode = {
    env: {
      appName: '',
    },
  }

  const originalEnv = process.env

  beforeEach(() => {
    vi.resetModules()
    vi.doMock('vscode', () => mockVSCode)
    // Clear environment variables that could affect detection
    delete process.env.CURSOR_TRACE_ID
    delete process.env.CURSOR_SESSION_ID
    delete process.env.WINDSURF_IPC_HOOK
    delete process.env.WINDSURF_PID
    delete process.env.CLAUDE_DESKTOP
    delete process.env.ANTHROPIC_CLAUDE
    delete process.env.WEBSTORM_VM_OPTIONS
    delete process.env.IDEA_VM_OPTIONS
    delete process.env.JETBRAINS_IDE
    delete process.env.VSCODE_IPC_HOOK
    delete process.env.VSCODE_PID
    delete process.env.TERM_PROGRAM
  })

  afterEach(() => {
    vi.resetAllMocks()
    // Restore original environment
    process.env = originalEnv
  })

  it('detects Visual Studio Code correctly', async () => {
    mockVSCode.env.appName = 'Visual Studio Code'

    const { detectAppType, AppType } = await import(
      '../src/shared/repositoryInfo'
    )

    expect(detectAppType()).toBe(AppType.VSCODE)
  })

  it('detects VSCode with different casing', async () => {
    mockVSCode.env.appName = 'visual studio code - insiders'

    const { detectAppType, AppType } = await import(
      '../src/shared/repositoryInfo'
    )

    expect(detectAppType()).toBe(AppType.VSCODE)
  })

  it('detects Cursor correctly', async () => {
    mockVSCode.env.appName = 'Cursor'

    const { detectAppType, AppType } = await import(
      '../src/shared/repositoryInfo'
    )

    expect(detectAppType()).toBe(AppType.CURSOR)
  })

  it('detects Cursor with different casing', async () => {
    mockVSCode.env.appName = 'cursor - the ai editor'

    const { detectAppType, AppType } = await import(
      '../src/shared/repositoryInfo'
    )

    expect(detectAppType()).toBe(AppType.CURSOR)
  })

  it('returns UNKNOWN for unrecognized apps', async () => {
    mockVSCode.env.appName = 'Some Unknown Editor'

    const { detectAppType, AppType } = await import(
      '../src/shared/repositoryInfo'
    )

    expect(detectAppType()).toBe(AppType.UNKNOWN)
  })

  it('handles empty app name', async () => {
    mockVSCode.env.appName = ''

    const { detectAppType, AppType } = await import(
      '../src/shared/repositoryInfo'
    )

    expect(detectAppType()).toBe(AppType.UNKNOWN)
  })
})
