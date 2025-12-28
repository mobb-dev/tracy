import fs from 'node:fs'
import path from 'node:path'

import * as dotenv from 'dotenv'
import { z } from 'zod'

dotenv.config({
  path: path.join(path.join(__dirname, '..'), '.env'),
  override: true,
})

const zodSchema = z.object({
  DD_RUM_TOKEN: z.string().default(''),
  API_URL: z.string().default('https://api.mobb.ai/v1/graphql'),
  WEB_APP_URL: z.string().default('https://app.mobb.ai'),
  HASURA_ACCESS_KEY: z.string().default('dummy'),
  LOCAL_GRAPHQL_ENDPOINT: z
    .string()
    .default('http://localhost:8080/v1/graphql'),
})

const env = zodSchema.parse(process.env)

export const { DD_RUM_TOKEN } = env

const packageJsonSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
})

const packageJson = packageJsonSchema.parse(
  JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  )
)

export const { version: EXTENSION_VERSION, name: EXTENSION_NAME } = packageJson
