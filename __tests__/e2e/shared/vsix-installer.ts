/**
 * VSIX extraction and installation utilities for E2E tests
 * Handles extracting VS Code extension packages and installing them
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import AdmZip from 'adm-zip'

export interface VSIXMetadata {
  version: string
  extensionId: string
  publisher: string
  name: string
  activationEvents?: string[]
  main?: string
  engines?: { vscode?: string }
}

export interface VSIXExtractionOptions {
  /** Whether to read and use metadata from package.json (default: true) */
  readMetadata?: boolean
  /** List of critical files that must exist after extraction */
  verifyFiles?: string[]
  /** Whether to show detailed logging (default: true) */
  verbose?: boolean
}

/**
 * Extract VSIX metadata from package.json
 */
function extractMetadata(tempExtractDir: string): VSIXMetadata {
  const packageJsonPath = path.join(tempExtractDir, 'extension', 'package.json')

  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`package.json not found at ${packageJsonPath}`)
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))

  return {
    version: packageJson.version || '0.0.0',
    publisher: packageJson.publisher || 'unknown',
    name: packageJson.name || 'unknown',
    extensionId: `${packageJson.publisher || 'unknown'}.${packageJson.name || 'unknown'}`,
    activationEvents: packageJson.activationEvents,
    main: packageJson.main,
    engines: packageJson.engines,
  }
}

/**
 * Extract a VSIX file to a target directory
 *
 * @param vsixPath - Path to the VSIX file
 * @param extensionsDir - Parent directory where extension should be installed
 * @param options - Extraction options
 * @returns Path to the installed extension directory
 */
export function extractVSIX(
  vsixPath: string,
  extensionsDir: string,
  options: VSIXExtractionOptions = {}
): string {
  const {
    readMetadata = true,
    verifyFiles = ['package.json'],
    verbose = true,
  } = options

  if (!fs.existsSync(vsixPath)) {
    throw new Error(`VSIX file not found: ${vsixPath}`)
  }

  // Ensure extensions directory exists
  fs.mkdirSync(extensionsDir, { recursive: true })

  if (verbose) {
    console.log(`📦 Installing extension via direct extraction...`)
    console.log(`   VSIX path: ${vsixPath}`)
    console.log(`   Target dir: ${extensionsDir}`)
  }

  // Extract VSIX (it's a ZIP file)
  const zip = new AdmZip(vsixPath)

  // Extract to temp directory first
  const tempExtractDir = path.join(extensionsDir, 'temp-extract')
  fs.mkdirSync(tempExtractDir, { recursive: true })

  if (verbose) {
    console.log(`📦 Extracting VSIX to temp directory...`)
  }
  zip.extractAllTo(tempExtractDir, true)

  // Read metadata if requested
  let metadata: VSIXMetadata | undefined
  if (readMetadata) {
    try {
      metadata = extractMetadata(tempExtractDir)
      if (verbose) {
        console.log(`📦 Extension metadata:`)
        console.log(`   Extension ID: ${metadata.extensionId}`)
        console.log(`   Version: ${metadata.version}`)
        console.log(`   Publisher: ${metadata.publisher}`)
        console.log(`   Name: ${metadata.name}`)
        if (metadata.activationEvents) {
          console.log(
            `   Activation Events: ${JSON.stringify(metadata.activationEvents)}`
          )
        }
        if (metadata.main) {
          console.log(`   Main: ${metadata.main}`)
        }
        if (metadata.engines?.vscode) {
          console.log(`   VS Code Engine: ${metadata.engines.vscode}`)
        }
      }
    } catch (err) {
      if (verbose) {
        console.log(
          `⚠️  Warning: Could not read metadata from package.json: ${err}`
        )
      }
    }
  }

  // Determine final installation directory name
  // VS Code expects: {publisher}.{name}-{version}
  let extensionInstallDir: string
  if (metadata) {
    extensionInstallDir = path.join(
      extensionsDir,
      `${metadata.extensionId}-${metadata.version}`
    )
  } else {
    // Fallback: use VSIX filename without extension
    const vsixBasename = path.basename(vsixPath, '.vsix')
    extensionInstallDir = path.join(extensionsDir, vsixBasename)
  }

  if (verbose) {
    console.log(`📦 Installing to: ${extensionInstallDir}`)
  }

  // Move contents from 'extension/' subfolder to final location
  // VSIX packages have their content in an 'extension' subdirectory
  const extractedExtDir = path.join(tempExtractDir, 'extension')
  if (fs.existsSync(extractedExtDir)) {
    if (verbose) {
      console.log(`📦 Moving from ${extractedExtDir} to ${extensionInstallDir}`)
    }
    fs.renameSync(extractedExtDir, extensionInstallDir)
  } else {
    // Fallback: no 'extension' subdirectory, move entire temp dir
    if (verbose) {
      console.log(`📦 Moving from ${tempExtractDir} to ${extensionInstallDir}`)
    }
    fs.renameSync(tempExtractDir, extensionInstallDir)
  }

  // Clean up temp directory if it still exists
  if (fs.existsSync(tempExtractDir)) {
    fs.rmSync(tempExtractDir, { recursive: true, force: true })
  }

  if (verbose) {
    console.log(`✅ Extension installed to: ${extensionInstallDir}`)

    // Show extension directory contents
    console.log(`📂 Extension directory contents:`)
    const extContents = fs.readdirSync(extensionInstallDir)
    for (const item of extContents) {
      const itemPath = path.join(extensionInstallDir, item)
      const stat = fs.statSync(itemPath)
      console.log(`   ${stat.isDirectory() ? '📁' : '📄'} ${item}`)
    }
  }

  // Verify critical files exist
  if (verifyFiles.length > 0) {
    for (const file of verifyFiles) {
      const filePath = path.join(extensionInstallDir, file)
      if (!fs.existsSync(filePath)) {
        throw new Error(
          `Critical file missing after extraction: ${file} at ${filePath}`
        )
      }
    }
    if (verbose) {
      console.log(
        `✅ All critical files verified (${verifyFiles.length} files)`
      )
    }
  }

  return extensionInstallDir
}
