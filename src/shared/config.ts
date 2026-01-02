import fs from 'node:fs'
import path from 'node:path'

import * as vscode from 'vscode'

/**
 * Extension configuration using a simplified approach.
 *
 * Configuration sources (in priority order):
 * 1. VS Code Settings - user explicitly set in settings.json (highest priority)
 * 2. Package.json defaults - extension-specific, set at build time
 *
 * This approach:
 * - Does NOT use process.env for URLs (avoids shared state between extensions)
 * - Does NOT use .env files for URLs
 * - Reads from THIS extension's own package.json via context.extensionPath
 * - Allows dev and prod extensions to coexist with different URLs
 */

type ExtensionConfig = {
  apiUrl: string
  webAppUrl: string
  extensionName: string
  extensionVersion: string
  isDevExtension: boolean
  /** True if config was loaded from package.json, false if using hardcoded fallbacks */
  isConfigFromPackageJson: boolean
  /** VS Code configuration section: 'mobbAiTracerDev' for dev, 'mobbAiTracer' for production */
  configSection: string
}

let cachedConfig: ExtensionConfig | null = null

// Production fallback URLs - used when package.json can't be read
const FALLBACK_API_URL = 'https://api.mobb.ai/v1/graphql'
const FALLBACK_WEB_APP_URL = 'https://app.mobb.ai'

/**
 * Initialize configuration. Must be called once at extension activation.
 * @param extensionPath - context.extensionPath from activate()
 */
export function initConfig(extensionPath: string): void {
  if (cachedConfig) {
    return
  }

  // Step 1: Read THIS extension's package.json for defaults and metadata
  const pkgPath = path.join(extensionPath, 'package.json')

  let pkgApiUrl = FALLBACK_API_URL
  let pkgWebAppUrl = FALLBACK_WEB_APP_URL
  let extensionName = 'mobb-ai-tracer'
  let extensionVersion = '0.0.0'
  let isDevExtension = false
  let isConfigFromPackageJson = false

  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))

      extensionName = pkg.name || extensionName
      extensionVersion = pkg.version || extensionVersion
      isDevExtension = extensionName.includes('-dev')

      const props = pkg.contributes?.configuration?.properties || {}
      // Dev extension uses 'mobbAiTracerDev.*' keys, production uses 'mobbAiTracer.*'
      const configPrefix = isDevExtension ? 'mobbAiTracerDev' : 'mobbAiTracer'
      if (props[`${configPrefix}.apiUrl`]?.default) {
        pkgApiUrl = props[`${configPrefix}.apiUrl`].default
        isConfigFromPackageJson = true
      }
      if (props[`${configPrefix}.webAppUrl`]?.default) {
        pkgWebAppUrl = props[`${configPrefix}.webAppUrl`].default
      }
    } catch (err) {
      console.error(
        '[CONFIG] Error reading package.json - using production fallback URLs:',
        err
      )
    }
  } else {
    console.warn(
      '[CONFIG] package.json not found - using production fallback URLs:',
      pkgPath
    )
  }

  // Step 2: Check VS Code settings for user overrides
  // Dev extension uses 'mobbAiTracerDev.*' settings, production uses 'mobbAiTracer.*'
  const vsConfigSection = isDevExtension ? 'mobbAiTracerDev' : 'mobbAiTracer'
  let finalApiUrl = pkgApiUrl
  let finalWebAppUrl = pkgWebAppUrl

  if (vscode.workspace.getConfiguration) {
    const vsConfig = vscode.workspace.getConfiguration(vsConfigSection)

    // Use inspect() to check if user explicitly set values (not just defaults)
    const apiUrlInspect = vsConfig.inspect<string>('apiUrl')
    const webAppUrlInspect = vsConfig.inspect<string>('webAppUrl')

    const userApiUrl =
      apiUrlInspect?.workspaceValue ?? apiUrlInspect?.globalValue
    const userWebAppUrl =
      webAppUrlInspect?.workspaceValue ?? webAppUrlInspect?.globalValue

    // User settings take priority over package.json defaults
    if (userApiUrl) {
      finalApiUrl = userApiUrl
    }
    if (userWebAppUrl) {
      finalWebAppUrl = userWebAppUrl
    }
  }

  cachedConfig = {
    apiUrl: finalApiUrl,
    webAppUrl: finalWebAppUrl,
    extensionName,
    extensionVersion,
    isDevExtension,
    isConfigFromPackageJson,
    configSection: vsConfigSection,
  }
}

/**
 * Get the extension configuration.
 * Throws if initConfig() hasn't been called.
 *
 * Returns a readonly view to prevent accidental mutation of cached config.
 */
export function getConfig(): Readonly<ExtensionConfig> {
  if (!cachedConfig) {
    throw new Error(
      'Extension config not initialized! Call initConfig(context.extensionPath) first.'
    )
  }
  return cachedConfig
}

/**
 * Check if configuration has changed for relevant settings.
 * Used to prompt user to reload window.
 */
export function hasRelevantConfigurationChanged(
  e: vscode.ConfigurationChangeEvent
): boolean {
  const section = cachedConfig?.configSection || 'mobbAiTracer'
  return (
    e.affectsConfiguration(`${section}.apiUrl`) ||
    e.affectsConfiguration(`${section}.webAppUrl`)
  )
}
