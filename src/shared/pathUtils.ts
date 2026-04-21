import * as path from 'node:path'

import { fileUriToFsPath } from '../mobbdev_src/utils/url'

/**
 * Convert a path-like string to an OS filesystem path.
 *
 * Delegates to the shared `fileUriToFsPath` for `file://` URIs, which
 * detects Windows drive-letter patterns and converts to Windows fsPath
 * regardless of host platform. Falls back to the original string for
 * non-`file://` inputs or malformed URIs.
 */
export function toOsPath(p: string): string {
  return fileUriToFsPath(p) ?? p
}

/**
 * Canonical form for a repository/file path, so string comparisons work
 * regardless of which code path produced the string.
 *
 * On Windows the same directory is reported in multiple forms by different
 * sources:
 *   - `git rev-parse --show-toplevel`  → `C:/Users/x/repo` (uppercase drive,
 *                                        forward slashes)
 *   - Node `path.join` / `fs.readdir`  → `c:\Users\x\repo` (as given by
 *                                        the workspace folder URI — often
 *                                        lowercase drive, backslashes)
 *   - VS Code `uri.fsPath`             → `c:\Users\x\repo` (Windows native,
 *                                        backslashes, VS Code's case)
 *
 * Without normalization these three strings all "point at the same directory"
 * but fail `===` / `startsWith` comparisons, producing duplicate repo
 * registrations, orphaned GitBlameCache HEAD listeners, and broken
 * repo-relative path lookups for AI blame.
 *
 * On POSIX paths are case-sensitive, so we only collapse `..` segments via
 * `path.normalize` and leave case alone.
 */
export function canonicalizeRepoPath(p: string): string {
  const normalized = path.normalize(p)
  if (process.platform === 'win32') {
    const lowerDrive =
      normalized.length > 0
        ? normalized[0].toLowerCase() + normalized.slice(1)
        : normalized
    // path.normalize on Windows already uses backslashes, but be defensive
    // in case a caller passes forward-slash input that normalize left alone.
    return lowerDrive.split('/').join('\\')
  }
  return normalized
}

/**
 * Case-aware equality for two path-like strings. On Windows paths are
 * case-insensitive and separator-agnostic; on POSIX strict equality.
 */
export function pathsEqual(a: string, b: string): boolean {
  return canonicalizeRepoPath(a) === canonicalizeRepoPath(b)
}
