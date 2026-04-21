import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  canonicalizeRepoPath,
  pathsEqual,
  toOsPath,
} from '../src/shared/pathUtils'
import type {
  GitRepository,
  RepositoryInfo,
} from '../src/shared/repositoryInfo'

// Mock dependencies that can cause timeouts
vi.mock('../src/mobbdev_src/features/analysis/scm/services/GitService', () => ({
  GitService: vi.fn().mockImplementation(() => ({
    isGitRepository: vi.fn().mockResolvedValue(false),
    getGitRoot: vi.fn().mockResolvedValue(''),
    getRemoteUrl: vi.fn().mockResolvedValue(''),
  })),
}))

vi.mock('../src/shared/gqlClientFactory', () => ({
  createGQLClient: vi.fn().mockResolvedValue({
    getLastOrg: vi.fn().mockResolvedValue({ organizationId: 'test-org' }),
    getUserInfo: vi.fn().mockResolvedValue({ email: 'test@test.com' }),
  }),
}))

vi.mock('../src/shared/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

const makeRepoInfo = (repos: GitRepository[]): RepositoryInfo => ({
  repositories: repos,
  userEmail: 'test@test.com',
  organizationId: 'org-1',
  appType: 'cursor',
  ideVersion: '0.1.0',
  mobbAppBaseUrl: '',
})

describe('getRelevantRepo', () => {
  const mockVSCode = {
    env: { appName: 'Cursor' },
    workspace: { workspaceFolders: [] },
  }

  beforeEach(() => {
    vi.resetModules()
    vi.doMock('vscode', () => mockVSCode)
  })

  afterEach(async () => {
    vi.resetAllMocks()
  })

  it('returns null when repoInfo is not initialized', async () => {
    const { getRelevantRepo } = await import('../src/shared/repositoryInfo')
    expect(getRelevantRepo('/some/path')).toBeNull()
  })

  it('returns null when repositories array is empty', async () => {
    const { getRelevantRepo, _setRepoInfoForTesting } =
      await import('../src/shared/repositoryInfo')
    _setRepoInfoForTesting(makeRepoInfo([]))
    expect(getRelevantRepo('/some/path')).toBeNull()
  })

  it('returns first repo for single-repo setup regardless of filePath', async () => {
    const { getRelevantRepo, _setRepoInfoForTesting } =
      await import('../src/shared/repositoryInfo')
    const repo = {
      gitRoot: '/workspace/project',
      gitRepoUrl: 'https://github.com/test/repo.git',
    }
    _setRepoInfoForTesting(makeRepoInfo([repo]))
    expect(getRelevantRepo('/unrelated/path')).toBe(repo)
    expect(getRelevantRepo()).toBe(repo)
  })

  it('matches correct repo by filePath in multi-repo setup', async () => {
    const { getRelevantRepo, _setRepoInfoForTesting } =
      await import('../src/shared/repositoryInfo')
    const repoA = {
      gitRoot: '/workspace/alpha',
      gitRepoUrl: 'https://github.com/test/alpha.git',
    }
    const repoB = {
      gitRoot: '/workspace/beta',
      gitRepoUrl: 'https://github.com/test/beta.git',
    }
    _setRepoInfoForTesting(makeRepoInfo([repoA, repoB]))
    expect(getRelevantRepo('/workspace/alpha/src/index.ts')).toBe(repoA)
    expect(getRelevantRepo('/workspace/beta/src/main.ts')).toBe(repoB)
  })

  it('avoids prefix collision: /project does not match /project-utils', async () => {
    const { getRelevantRepo, _setRepoInfoForTesting } =
      await import('../src/shared/repositoryInfo')
    const repoShort = {
      gitRoot: '/workspace/project',
      gitRepoUrl: 'https://github.com/test/project.git',
    }
    const repoLong = {
      gitRoot: '/workspace/project-utils',
      gitRepoUrl: 'https://github.com/test/project-utils.git',
    }
    _setRepoInfoForTesting(makeRepoInfo([repoShort, repoLong]))

    // File in /workspace/project-utils should NOT match /workspace/project
    expect(getRelevantRepo('/workspace/project-utils/src/index.ts')).toBe(
      repoLong
    )
    // File in /workspace/project should still match /workspace/project
    expect(getRelevantRepo('/workspace/project/src/index.ts')).toBe(repoShort)
  })

  it('returns null for multi-repo when filePath matches no repo', async () => {
    const { getRelevantRepo, _setRepoInfoForTesting } =
      await import('../src/shared/repositoryInfo')
    const repoA = {
      gitRoot: '/workspace/alpha',
      gitRepoUrl: 'https://github.com/test/alpha.git',
    }
    const repoB = {
      gitRoot: '/workspace/beta',
      gitRepoUrl: 'https://github.com/test/beta.git',
    }
    _setRepoInfoForTesting(makeRepoInfo([repoA, repoB]))
    expect(getRelevantRepo('/somewhere/else/file.ts')).toBeNull()
  })

  it('returns null for multi-repo when filePath is not provided', async () => {
    const { getRelevantRepo, _setRepoInfoForTesting } =
      await import('../src/shared/repositoryInfo')
    const repoA = {
      gitRoot: '/workspace/alpha',
      gitRepoUrl: 'https://github.com/test/alpha.git',
    }
    const repoB = {
      gitRoot: '/workspace/beta',
      gitRepoUrl: 'https://github.com/test/beta.git',
    }
    _setRepoInfoForTesting(makeRepoInfo([repoA, repoB]))
    expect(getRelevantRepo()).toBeNull()
  })
})

describe('toOsPath', () => {
  it('converts a POSIX file:// URI to an OS path', () => {
    expect(toOsPath('file:///home/user/project/file.ts')).toBe(
      '/home/user/project/file.ts'
    )
  })

  it('decodes URL-encoded characters in the URI', () => {
    // %20 = space
    expect(toOsPath('file:///home/user/my%20project/file.ts')).toBe(
      '/home/user/my project/file.ts'
    )
  })

  it('passes through bare OS paths unchanged (POSIX)', () => {
    expect(toOsPath('/home/user/project/file.ts')).toBe(
      '/home/user/project/file.ts'
    )
  })

  it('passes through bare OS paths unchanged (Windows-style)', () => {
    // A Windows path like "C:\Users\..." does not start with "file://",
    // so it must be returned as-is on any host platform.
    expect(toOsPath('C:\\Users\\test\\project\\file.ts')).toBe(
      'C:\\Users\\test\\project\\file.ts'
    )
  })

  it('passes through empty strings unchanged', () => {
    expect(toOsPath('')).toBe('')
  })

  it('converts a Windows file:// URI with a literal drive letter to an OS path', () => {
    // toOsPath delegates to fileUriToFsPath which detects the Windows
    // drive-letter pattern and converts to Windows fsPath regardless of
    // host platform. No leading "/" — that was the old broken behavior.
    const result = toOsPath('file:///C:/Users/test/webgoat/foo.ts')
    expect(result).toMatch(/^[Cc]:[\\/]Users[\\/]test[\\/]webgoat[\\/]foo\.ts$/)
  })

  it('decodes a URL-encoded drive-letter colon (%3A) in a Windows URI', () => {
    const result = toOsPath('file:///c%3A/Users/test/webgoat/foo.ts')
    expect(result).toMatch(/^[Cc]:[\\/]Users[\\/]test[\\/]webgoat[\\/]foo\.ts$/)
  })
})

describe('canonicalizeRepoPath', () => {
  // `canonicalizeRepoPath` reads `process.platform` at call time (not module
  // load), so toggling the global is enough to exercise the Windows branch
  // on a POSIX CI host. Note that this does NOT patch `path.normalize`'s
  // platform — the function handles Windows separator conversion with an
  // explicit `.split('/').join('\\')` after the platform check, so the
  // expected output is correct regardless of host platform.
  const originalPlatform = process.platform
  const setPlatform = (p: NodeJS.Platform) => {
    Object.defineProperty(process, 'platform', { value: p, configurable: true })
  }

  afterEach(() => {
    setPlatform(originalPlatform)
  })

  it('leaves POSIX paths case-intact on non-Windows hosts', () => {
    setPlatform('darwin')
    expect(canonicalizeRepoPath('/Users/dev/Repo')).toBe('/Users/dev/Repo')
    expect(canonicalizeRepoPath('/users/dev/repo')).toBe('/users/dev/repo')
  })

  it('collapses .. segments on POSIX', () => {
    setPlatform('darwin')
    expect(canonicalizeRepoPath('/Users/dev/../dev/repo')).toBe(
      '/Users/dev/repo'
    )
  })

  it('lowercases drive letter on Windows', () => {
    setPlatform('win32')
    expect(canonicalizeRepoPath('C:\\Users\\dev\\repo')).toBe(
      'c:\\Users\\dev\\repo'
    )
    expect(canonicalizeRepoPath('c:\\Users\\dev\\repo')).toBe(
      'c:\\Users\\dev\\repo'
    )
  })

  it('converts forward slashes to backslashes on Windows', () => {
    setPlatform('win32')
    expect(canonicalizeRepoPath('C:/Users/dev/repo')).toBe(
      'c:\\Users\\dev\\repo'
    )
  })

  it('produces identical output for git-CLI and path.join forms on Windows', () => {
    // Real-world: git rev-parse --show-toplevel returns forward slashes
    // with uppercase drive letter; path.join / VS Code fsPath returns
    // backslashes with whatever case VS Code gave (often lowercase).
    setPlatform('win32')
    const fromGit = canonicalizeRepoPath('C:/Users/test/webgoat')
    const fromPathJoin = canonicalizeRepoPath('c:\\Users\\test\\webgoat')
    expect(fromGit).toBe(fromPathJoin)
  })
})

describe('pathsEqual', () => {
  const originalPlatform = process.platform
  const setPlatform = (p: NodeJS.Platform) => {
    Object.defineProperty(process, 'platform', { value: p, configurable: true })
  }

  afterEach(() => {
    setPlatform(originalPlatform)
  })

  it('returns true for identical POSIX paths', () => {
    setPlatform('darwin')
    expect(pathsEqual('/Users/dev/repo', '/Users/dev/repo')).toBe(true)
  })

  it('is case-sensitive on POSIX', () => {
    setPlatform('darwin')
    expect(pathsEqual('/Users/Dev/Repo', '/users/dev/repo')).toBe(false)
  })

  it('is case-insensitive on Windows for the drive letter', () => {
    setPlatform('win32')
    expect(
      pathsEqual('C:\\Users\\test\\webgoat', 'c:\\Users\\test\\webgoat')
    ).toBe(true)
  })

  it('treats forward and back slashes equivalently on Windows', () => {
    setPlatform('win32')
    expect(
      pathsEqual('C:/Users/test/webgoat', 'c:\\Users\\test\\webgoat')
    ).toBe(true)
  })

  it('distinguishes different directories on Windows', () => {
    setPlatform('win32')
    expect(
      pathsEqual('c:\\Users\\test\\webgoat', 'c:\\Users\\test\\other')
    ).toBe(false)
  })
})

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

    const { detectAppType, AppType } =
      await import('../src/shared/repositoryInfo')

    expect(detectAppType()).toBe(AppType.VSCODE)
  })

  it('detects VSCode with different casing', async () => {
    mockVSCode.env.appName = 'visual studio code - insiders'

    const { detectAppType, AppType } =
      await import('../src/shared/repositoryInfo')

    expect(detectAppType()).toBe(AppType.VSCODE)
  })

  it('detects Cursor correctly', async () => {
    mockVSCode.env.appName = 'Cursor'

    const { detectAppType, AppType } =
      await import('../src/shared/repositoryInfo')

    expect(detectAppType()).toBe(AppType.CURSOR)
  })

  it('detects Cursor with different casing', async () => {
    mockVSCode.env.appName = 'cursor - the ai editor'

    const { detectAppType, AppType } =
      await import('../src/shared/repositoryInfo')

    expect(detectAppType()).toBe(AppType.CURSOR)
  })

  it('returns UNKNOWN for unrecognized apps', async () => {
    mockVSCode.env.appName = 'Some Unknown Editor'

    const { detectAppType, AppType } =
      await import('../src/shared/repositoryInfo')

    expect(detectAppType()).toBe(AppType.UNKNOWN)
  })

  it('handles empty app name', async () => {
    mockVSCode.env.appName = ''

    const { detectAppType, AppType } =
      await import('../src/shared/repositoryInfo')

    expect(detectAppType()).toBe(AppType.UNKNOWN)
  })
})
