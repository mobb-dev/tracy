import fs from 'node:fs'
import path from 'node:path'

import * as dotenv from 'dotenv'
import { z } from 'zod'

/**
 * Static extension metadata and secrets.
 *
 * This module provides:
 * - EXTENSION_NAME, EXTENSION_VERSION: Read from package.json at module load time
 * - DD_RUM_TOKEN: Read from .env file (for secrets only)
 *
 * For API URLs and other configuration, use shared/config.ts instead.
 * That module uses context.extensionPath to support dev/prod coexistence.
 */

// Read package.json for extension metadata
const packageJsonPath = path.join(__dirname, '..', 'package.json')
const packageJsonSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
})

let extensionName = 'mobb-ai-tracer'
let extensionVersion = '0.0.0'

if (fs.existsSync(packageJsonPath)) {
  try {
    const packageJson = packageJsonSchema.parse(
      JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
    )
    extensionName = packageJson.name
    extensionVersion = packageJson.version
  } catch (err) {
    console.error('[ENV] Error reading package.json:', err)
  }
}

export const EXTENSION_NAME = extensionName
export const EXTENSION_VERSION = extensionVersion

// Read .env file for secrets only (DD_RUM_TOKEN)
// This is separate from URL configuration which is handled by shared/config.ts
const envPath = path.join(__dirname, '..', '.env')
dotenv.config({ path: envPath })

const secretsSchema = z.object({
  DD_RUM_TOKEN: z.string().default(''),
})

const secrets = secretsSchema.parse(process.env)

export const { DD_RUM_TOKEN } = secrets
