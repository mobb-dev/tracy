import { defineConfig } from '@playwright/test'

/**
 * Playwright configuration for Cursor and VS Code extension E2E tests
 */
export default defineConfig({
  testDir: '.', // Config is already in __tests__/e2e/

  // Test timeout
  timeout: 120000, // 2 minutes per test

  // Global setup/teardown timeout
  globalTimeout: 600000, // 10 minutes for all tests

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

  // Separate projects for Cursor and VS Code tests
  projects: [
    {
      name: 'cursor',
      testDir: './cursor', // Relative to config file location (__tests__/e2e/)
      testMatch: '**/*automation.test.ts',
    },
    {
      name: 'vscode',
      testDir: './vscode', // Relative to config file location (__tests__/e2e/)
      testMatch: '**/*automation.test.ts',
    },
  ],
})
