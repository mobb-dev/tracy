import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      exclude: ['node_modules', './out', 'vitest.config.ts'],
      reporter: ['html', 'text', 'lcov', 'lcovonly'],
      reportsDirectory: 'coverage',
    },
  },
})
