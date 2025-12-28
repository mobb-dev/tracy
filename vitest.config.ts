import { createRequire } from 'node:module'

import { defineConfig } from 'vitest/config'

const require = createRequire(import.meta.url)
const debugEntry = require.resolve('debug')

export default defineConfig({
  resolve: {
    // Force Vite/Vitest to resolve `debug` to a real file path so that
    // `require('./node.js')` inside the package is evaluated relative to the
    // correct directory.
    alias: {
      debug: debugEntry,
    },
  },
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
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
