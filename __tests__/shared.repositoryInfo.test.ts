import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('detectAppType', () => {
  const mockVSCode = {
    env: {
      appName: '',
    },
  }

  beforeEach(() => {
    vi.resetModules()
    vi.doMock('vscode', () => mockVSCode)
  })

  afterEach(() => {
    vi.resetAllMocks()
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
