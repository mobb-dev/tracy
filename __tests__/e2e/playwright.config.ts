import { defineConfig } from '@playwright/test'

/**
 * Playwright configuration for Cursor and VS Code extension E2E tests
 */
export default defineConfig({
  testDir: '.', // Config is already in __tests__/e2e/

  // Test timeout - increased for Windows which is slower
  timeout: process.platform === 'win32' ? 180000 : 120000,

  // Whole-run ceiling. This MUST exceed `retries+1` × the per-test timeout, or a
  // slow first attempt makes the retry impossible — the run hits globalTimeout
  // mid-retry and reports "Timed out waiting Ns for the test suite" instead of a
  // real result. The Windows VS Code test sets a 12-min per-test budget
  // (TEST_TIMEOUT) and CI runs with retries:1 → 2 attempts × 12 min = 24 min;
  // 25 min keeps that under the ceiling. The Windows job
  // itself allows 45 min, so this ceiling is the binding constraint, not CI.
  // Other tests finish well within this — it's a ceiling, not a fixed wait.
  // TODO: reduce once login reliably reuses a captured browser storageState.
  globalTimeout: 1500000, // 25 minutes

  // Fail fast on CI
  fullyParallel: false, // Run tests serially for Electron tests
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // Only 1 worker for Electron tests to avoid conflicts

  // Reporter configuration
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],

  // Output configuration
  use: {
    // Base URL for mock server
    baseURL: 'http://localhost:3000',

    // Collect trace on failure
    trace: 'retain-on-failure',

    // Screenshot on failure
    screenshot: 'only-on-failure',

    // Video - always record for E2E tests
    video: 'on',
  },

  // Test output directory
  outputDir: 'test-results',

  // Separate projects for Cursor and VS Code tests. The testMatch globs use
  // `*automation*` so they pick up both the Linux (`playwright-automation.test.ts`)
  // and Windows (`playwright-automation.windows.test.ts`) variants without needing
  // a separate config file per platform.
  projects: [
    {
      name: 'cursor',
      testDir: './cursor', // Relative to config file location (__tests__/e2e/)
      testMatch: ['**/*automation*.test.ts'],
    },
    {
      name: 'vscode',
      testDir: './vscode', // Relative to config file location (__tests__/e2e/)
      testMatch: ['**/*automation*.test.ts'],
    },
  ],
})
