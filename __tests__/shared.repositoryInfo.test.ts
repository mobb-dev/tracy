import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
