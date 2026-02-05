import { createRequire } from 'node:module'

import { defineConfig } from 'vitest/config'

const require = createRequire(import.meta.url)
const debugEntry = require.resolve('debug')
const dotenvEntry = require.resolve('dotenv')
const httpsProxyAgentEntry = require.resolve('https-proxy-agent')
const httpProxyAgentEntry = require.resolve('http-proxy-agent')
const nanospinnerEntry = require.resolve('nanospinner')
const semverEntry = require.resolve('semver')
const azureDevopsNodeApiEntry = require.resolve('azure-devops-node-api')
const bitbucketEntry = require.resolve('bitbucket/lib/index.js')
const undiciEntry = require.resolve('undici')
const admZipEntry = require.resolve('adm-zip')

export default defineConfig({
  resolve: {
    // Force Vite/Vitest to resolve `debug` to a real file path so that
    // `require('./node.js')` inside the package is evaluated relative to the
    // correct directory.
    alias: {
      debug: debugEntry,
      dotenv: dotenvEntry,
      'https-proxy-agent': httpsProxyAgentEntry,
      'http-proxy-agent': httpProxyAgentEntry,
      nanospinner: nanospinnerEntry,
      semver: semverEntry,
      'azure-devops-node-api': azureDevopsNodeApiEntry,
      bitbucket: bitbucketEntry,
      undici: undiciEntry,
      'adm-zip': admZipEntry,
    },
  },
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    exclude: ['__tests__/e2e/**', 'node_modules/**'],
    setupFiles: ['__tests__/setupEnv.ts', '__tests__/setupMocks.ts'],
    reporters: ['default'],
    deps: {
      // Vitest's SSR deps optimizer can break CJS packages that rely on
      // relative `require()` (e.g. `debug` requiring `./node.js`).
      optimizer: {
        ssr: {
          enabled: false,
        },
      },
    },
    coverage: {
      provider: 'v8',
      exclude: ['node_modules', './out', 'vitest.config.ts'],
      reporter: ['html', 'text', 'lcov', 'lcovonly'],
      reportsDirectory: 'coverage',
    },
  },
})
