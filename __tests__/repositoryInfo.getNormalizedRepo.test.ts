import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  _setRepoInfoForTesting,
  getNormalizedRepo,
  type RepositoryInfo,
} from '../src/shared/repositoryInfo'

vi.mock('vscode', () => ({ workspace: { workspaceFolders: [] } }))
vi.mock('../src/shared/gqlClientFactory', () => ({
  createGQLClient: vi.fn().mockResolvedValue({}),
}))
vi.mock('../src/shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

/**
 * Regression coverage for the Cursor/extension AI-blame repo-attribution gap:
 * getNormalizedRepo used to discard repos whose remote URL parseScmURL classifies
 * as scmType "Unknown" (self-hosted / enterprise SCM), returning null — which
 * dropped repositoryUrl AND branch/commitSha together for those users. It must now
 * keep the (already-canonical) URL and attach fresh branch/commit.
 */
describe('getNormalizedRepo — self-hosted / Unknown SCM hosts', () => {
  let repoPath: string

  const setRepoInfo = (gitRepoUrl: string) =>
    _setRepoInfoForTesting({
      repositories: [
        { gitRoot: repoPath, gitRepoUrl, branch: null, commitSha: null },
      ],
      userEmail: 'test@example.com',
      organizationId: 'org',
      appType: 'VSCode',
      ideVersion: '0.0.0',
      mobbAppBaseUrl: 'https://app.mobb.ai',
    } as unknown as RepositoryInfo)

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'norm-repo-'))
    execSync('git init --initial-branch=main', {
      cwd: repoPath,
      stdio: 'ignore',
    })
    execSync('git config user.name "Test User"', {
      cwd: repoPath,
      stdio: 'ignore',
    })
    execSync('git config user.email "test@example.com"', {
      cwd: repoPath,
      stdio: 'ignore',
    })
    writeFileSync(join(repoPath, 'file.txt'), 'content')
    execSync('git add .', { cwd: repoPath, stdio: 'ignore' })
    execSync('git commit -m "init"', { cwd: repoPath, stdio: 'ignore' })
  })

  afterEach(() => {
    _setRepoInfoForTesting(null)
    try {
      rmSync(repoPath, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  it('keeps a self-hosted remote and attaches fresh branch/commit', async () => {
    setRepoInfo('https://gitlab.acme-internal.com/group/sub/repo')

    const repo = await getNormalizedRepo(join(repoPath, 'file.txt'))

    // The bug: this used to be null (Unknown scmType discarded).
    expect(repo).not.toBeNull()
    expect(repo?.gitRepoUrl).toBe(
      'https://gitlab.acme-internal.com/group/sub/repo'
    )
    expect(repo?.branch).toBe('main')
    expect(repo?.commitSha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('still resolves a recognized cloud remote', async () => {
    setRepoInfo('https://github.com/mobb-dev/example')

    const repo = await getNormalizedRepo(join(repoPath, 'file.txt'))

    expect(repo?.gitRepoUrl).toBe('https://github.com/mobb-dev/example')
    expect(repo?.branch).toBe('main')
  })
})
