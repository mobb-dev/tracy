import * as vscode from 'vscode'

/**
 * Loads VS Code configuration settings and overrides environment variables.
 * This must be called BEFORE any modules that use constants are imported.
 * We use console.log here because this runs before logger initialization.
 */
export function loadConfigurationToEnv(): void {
  // Check if getConfiguration exists (might not be available in test environment)
  if (!vscode.workspace.getConfiguration) {
    return
  }

  const config = vscode.workspace.getConfiguration('mobbAiTracer')

  const apiUrl = config.get<string>('apiUrl')
  const webAppUrl = config.get<string>('webAppUrl')

  if (apiUrl) {
    process.env.API_URL = apiUrl
  }

  if (webAppUrl) {
    process.env.WEB_APP_URL = webAppUrl
  }
}

/**
 * Checks if configuration has changed for relevant settings
 */
export function hasRelevantConfigurationChanged(
  e: vscode.ConfigurationChangeEvent
): boolean {
  return (
    e.affectsConfiguration('mobbAiTracer.apiUrl') ||
    e.affectsConfiguration('mobbAiTracer.webAppUrl')
  )
}
