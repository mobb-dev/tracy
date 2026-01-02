import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock vscode before importing config
vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      inspect: vi.fn(() => ({
        workspaceValue: undefined,
        globalValue: undefined,
      })),
    })),
  },
}))

describe('config module', () => {
  beforeEach(() => {
    // Reset the cached config by reimporting the module
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('production configuration', () => {
    it('loads production URLs from package.json defaults', async () => {
      // Re-import to get fresh module state
      const { initConfig, getConfig } = await import('../src/shared/config')

      // Use the actual extension path (points to real package.json)
      const extensionPath = path.join(__dirname, '..')
      initConfig(extensionPath)

      const config = getConfig()

      // Verify production values from package.json
      expect(config.extensionName).toBe('mobb-ai-tracer')
      expect(config.apiUrl).toBe('https://api.mobb.ai/v1/graphql')
      expect(config.webAppUrl).toBe('https://app.mobb.ai')
      expect(config.isDevExtension).toBe(false)
    })

    it('detects production extension (no -dev in name)', async () => {
      const { initConfig, getConfig } = await import('../src/shared/config')

      const extensionPath = path.join(__dirname, '..')
      initConfig(extensionPath)

      const config = getConfig()

      expect(config.extensionName).not.toContain('-dev')
      expect(config.isDevExtension).toBe(false)
    })
  })

  describe('dev extension simulation', () => {
    it('detects dev extension when name contains -dev', async () => {
      const { initConfig, getConfig } = await import('../src/shared/config')

      // Create a temp directory with a dev package.json
      const tempDir = path.join(__dirname, 'temp-dev-ext')
      fs.mkdirSync(tempDir, { recursive: true })

      // Dev extension uses 'mobbAiTracerDev.*' keys to avoid conflicts with production
      const devPackageJson = {
        name: 'mobb-ai-tracer-dev',
        version: '0.2.18-dev',
        contributes: {
          configuration: {
            properties: {
              'mobbAiTracerDev.apiUrl': {
                default: 'http://localhost:8080/v1/graphql',
              },
              'mobbAiTracerDev.webAppUrl': {
                default: 'http://localhost:5173',
              },
            },
          },
        },
      }

      fs.writeFileSync(
        path.join(tempDir, 'package.json'),
        JSON.stringify(devPackageJson, null, 2)
      )

      try {
        initConfig(tempDir)
        const config = getConfig()

        expect(config.extensionName).toBe('mobb-ai-tracer-dev')
        expect(config.apiUrl).toBe('http://localhost:8080/v1/graphql')
        expect(config.webAppUrl).toBe('http://localhost:5173')
        expect(config.isDevExtension).toBe(true)
      } finally {
        // Cleanup
        fs.rmSync(tempDir, { recursive: true, force: true })
      }
    })

    it('loads sandbox URLs when configured in package.json', async () => {
      const { initConfig, getConfig } = await import('../src/shared/config')

      const tempDir = path.join(__dirname, 'temp-sandbox-ext')
      fs.mkdirSync(tempDir, { recursive: true })

      // Dev extension uses 'mobbAiTracerDev.*' keys to avoid conflicts with production
      const sandboxPackageJson = {
        name: 'mobb-ai-tracer-dev',
        version: '0.2.18-dev',
        contributes: {
          configuration: {
            properties: {
              'mobbAiTracerDev.apiUrl': {
                default: 'https://api-st-stenant.mobb.dev/v1/graphql',
              },
              'mobbAiTracerDev.webAppUrl': {
                default: 'https://st-stenant.mobb.dev',
              },
            },
          },
        },
      }

      fs.writeFileSync(
        path.join(tempDir, 'package.json'),
        JSON.stringify(sandboxPackageJson, null, 2)
      )

      try {
        initConfig(tempDir)
        const config = getConfig()

        expect(config.apiUrl).toBe('https://api-st-stenant.mobb.dev/v1/graphql')
        expect(config.webAppUrl).toBe('https://st-stenant.mobb.dev')
        expect(config.isDevExtension).toBe(true)
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true })
      }
    })
  })

  describe('fallback behavior', () => {
    it('uses hardcoded defaults when package.json is missing', async () => {
      const { initConfig, getConfig } = await import('../src/shared/config')

      // Use a non-existent path
      const nonExistentPath = '/non/existent/path'
      initConfig(nonExistentPath)

      const config = getConfig()

      // Should fall back to hardcoded production defaults
      expect(config.apiUrl).toBe('https://api.mobb.ai/v1/graphql')
      expect(config.webAppUrl).toBe('https://app.mobb.ai')
      expect(config.extensionName).toBe('mobb-ai-tracer')
      expect(config.isDevExtension).toBe(false)
    })
  })

  describe('config caching', () => {
    it('only initializes once', async () => {
      const { initConfig, getConfig } = await import('../src/shared/config')

      const extensionPath = path.join(__dirname, '..')
      initConfig(extensionPath)
      const config1 = getConfig()

      // Try to init again with different path (should be ignored)
      initConfig('/different/path')
      const config2 = getConfig()

      // Should be the same config object
      expect(config1).toBe(config2)
      expect(config1.apiUrl).toBe('https://api.mobb.ai/v1/graphql')
    })

    it('throws if getConfig called before initConfig', async () => {
      const { getConfig } = await import('../src/shared/config')

      expect(() => getConfig()).toThrow(
        'Extension config not initialized! Call initConfig(context.extensionPath) first.'
      )
    })
  })

  describe('hasRelevantConfigurationChanged', () => {
    it('returns true when apiUrl configuration changes', async () => {
      const { hasRelevantConfigurationChanged } = await import(
        '../src/shared/config'
      )

      const mockEvent = {
        affectsConfiguration: (section: string) =>
          section === 'mobbAiTracer.apiUrl',
      }

      expect(hasRelevantConfigurationChanged(mockEvent as any)).toBe(true)
    })

    it('returns true when webAppUrl configuration changes', async () => {
      const { hasRelevantConfigurationChanged } = await import(
        '../src/shared/config'
      )

      const mockEvent = {
        affectsConfiguration: (section: string) =>
          section === 'mobbAiTracer.webAppUrl',
      }

      expect(hasRelevantConfigurationChanged(mockEvent as any)).toBe(true)
    })

    it('returns false when unrelated configuration changes', async () => {
      const { hasRelevantConfigurationChanged } = await import(
        '../src/shared/config'
      )

      const mockEvent = {
        affectsConfiguration: (section: string) =>
          section === 'editor.fontSize',
      }

      expect(hasRelevantConfigurationChanged(mockEvent as any)).toBe(false)
    })
  })
})
