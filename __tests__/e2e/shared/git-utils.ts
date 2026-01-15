/**
 * Git utilities for E2E tests
 * Handles git repository initialization for test workspaces
 */

import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface GitInitOptions {
  /** Email for git config (default: "test@example.com") */
  userEmail?: string
  /** Name for git config (default: "Test User") */
  userName?: string
  /** Remote origin URL (default: "https://github.com/test-org/test-repo.git") */
  remoteUrl?: string
  /** Whether to create an initial commit (default: true) */
  createInitialCommit?: boolean
  /** Commit message for initial commit (default: "Initial test workspace") */
  commitMessage?: string
  /** Whether to log success/errors (default: true) */
  verbose?: boolean
}

/**
 * Initialize a git repository in a directory
 *
 * @param workspaceDir - Directory where git repo should be initialized
 * @param options - Git configuration options
 * @throws Does not throw - logs errors if git commands fail
 */
export async function initGitRepository(
  workspaceDir: string,
  options: GitInitOptions = {}
): Promise<void> {
  const {
    userEmail = 'test@example.com',
    userName = 'Test User',
    remoteUrl = 'https://github.com/test-org/test-repo.git',
    createInitialCommit = true,
    commitMessage = 'Initial test workspace',
    verbose = true,
  } = options

  const gitDir = path.join(workspaceDir, '.git')

  // Skip if already initialized
  if (fs.existsSync(gitDir)) {
    if (verbose) {
      console.log('⏭️  Git repository already initialized, skipping')
    }
    return
  }

  const execOptions: Parameters<typeof execSync>[1] = {
    cwd: workspaceDir,
    stdio: 'pipe',
    shell: '/bin/bash',
  }

  try {
    // Initialize repository
    execSync('git init', execOptions)

    // Configure user identity
    execSync(`git config user.email "${userEmail}"`, execOptions)
    execSync(`git config user.name "${userName}"`, execOptions)

    // Add remote
    execSync(`git remote add origin ${remoteUrl}`, execOptions)

    // Create initial commit if requested
    if (createInitialCommit) {
      execSync('git add -A', execOptions)
      execSync(`git commit -m "${commitMessage}" --allow-empty`, execOptions)
    }

    if (verbose) {
      console.log('✅ Git repository initialized')
    }
  } catch (gitErr) {
    if (verbose) {
      console.log(`⚠️  Could not initialize git: ${gitErr}`)
    }
    // Don't throw - git initialization is not critical for tests
  }
}
