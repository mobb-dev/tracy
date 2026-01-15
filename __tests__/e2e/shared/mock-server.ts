import type { Server } from 'node:http'

import express from 'express'

export type InferenceUpload = {
  tool: string
  model: string
  inference: string
  responseTime: string
  prompts: Array<{
    type: 'USER_PROMPT' | 'AI_RESPONSE' | 'AI_THINKING' | 'TOOL_EXECUTION'
    text?: string
    tokens?: {
      inputCount: number
      outputCount: number
    }
    date?: Date
    attachedFiles?: Array<{
      relativePath: string
      startLine: number
    }>
    tool?: {
      name: string
      parameters: string
      result: string
      rawArguments: string
      accepted: boolean
    }
  }>
}

export class MockUploadServer {
  private app = express()
  private server: Server | null = null
  private uploads: InferenceUpload[] = []
  private port: number
  private requestLog: Array<{ method: string; path: string; body: unknown }> = []
  // Store S3 upload content separately, keyed by upload key
  private s3Uploads: Map<string, string> = new Map()
  // Store callback for Copilot OAuth URL capture
  private copilotAuthCallback: ((url: string) => Promise<void>) | null = null

  constructor(port: number) {
    this.port = port
    this.setupRoutes()
  }

  setCopilotAuthCallback(callback: (url: string) => Promise<void>): void {
    this.copilotAuthCallback = callback
  }

  private setupRoutes() {
    this.app.use(express.json({ limit: '50mb' }))

    // Log all requests
    this.app.use((req, res, next) => {
      this.requestLog.push({
        method: req.method,
        path: req.path,
        body: req.body,
      })
      next()
    })

    // Route handlers (extracted for better organization)
    this.app.post('/api/auth/validate', this.handleAuthValidation.bind(this))
    this.app.get('/api/auth/validate', this.handleAuthValidation.bind(this))
    this.app.post('/graphql', this.handleGraphQL.bind(this))
    this.app.post(
      '/mock-s3-upload',
      express.raw({ type: 'multipart/form-data', limit: '50mb' }),
      this.handleS3Upload.bind(this)
    )
    this.app.post('/api/upload-ai-blame', this.handleRestUpload.bind(this))
    this.app.get('/health', this.handleHealthCheck.bind(this))
    this.app.get('/debug/uploads', this.handleDebugUploads.bind(this))
    this.app.get('/debug/requests', this.handleDebugRequests.bind(this))
    this.app.post('/copilot-auth-url', this.handleCopilotAuth.bind(this))
    this.app.post('/api/rest/mcp/track', this.handleMcpTracking.bind(this))

    // Catch-all route - MUST be last!
    this.app.all('*', this.handleUnknownRoute.bind(this))
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Route Handlers
  // ═══════════════════════════════════════════════════════════════════════════

  private handleAuthValidation(req: express.Request, res: express.Response) {
    console.log(`  [Mock] Auth validation request (${req.method})`)
    res.json({ valid: true, user: 'test-user' })
  }

  private handleGraphQL(req: express.Request, res: express.Response) {
      const operationName = req.body.operationName || 'UNKNOWN'
      const query = req.body.query || ''
      const variables = req.body.variables || {}

      // Log every GraphQL request with full details
      console.log(`  [Mock] GraphQL request: ${operationName}`)

      // For unknown operations, log full request body for debugging
      const knownOperations = [
        'Me',
        'verifyApiConnection',
        'validateUserToken',
        'getLastOrg',
        'CreateCommunityUser',
        'UploadAIBlameInferencesInit', // Note: PascalCase!
        'FinalizeAIBlameInferencesUpload', // Note: PascalCase!
      ]
      if (!knownOperations.includes(operationName)) {
        console.log(`  [Mock] ⚠️  UNKNOWN OPERATION: ${operationName}`)
        console.log(`  [Mock]   Query: ${query.substring(0, 200)}...`)
        console.log(
          `  [Mock]   Variables: ${JSON.stringify(variables).substring(0, 500)}`
        )
      }

      // Check if this looks like an upload operation (by checking query content)
      if (
        query.toLowerCase().includes('upload') ||
        query.toLowerCase().includes('inference') ||
        query.toLowerCase().includes('blame')
      ) {
        console.log(`  [Mock] 📤 Detected upload-related query!`)
        console.log(`  [Mock]   Full variables: ${JSON.stringify(variables)}`)
      }

      // Handle different GraphQL operations
      // NOTE: The extension calls 'Me' to get user info on startup
      if (operationName === 'Me') {
        res.json({
          data: {
            me: {
              id: 'test-user-id',
              email: 'test@example.com',
              name: 'Test User',
            },
          },
        })
      } else if (req.body.operationName === 'verifyApiConnection') {
        res.json({
          data: {
            verifyApiConnection: true,
          },
        })
      } else if (req.body.operationName === 'validateUserToken') {
        res.json({
          data: {
            validateUserToken: 'test-user',
          },
        })
      } else if (req.body.operationName === 'getLastOrg') {
        res.json({
          data: {
            user: [
              {
                userOrganizationsAndUserOrganizationRoles: [
                  {
                    organization: {
                      id: 'test-org-id',
                    },
                  },
                ],
              },
            ],
          },
        })
      } else if (operationName === 'UploadAIBlameInferencesInit') {
        // Capture the upload session metadata from the init request
        // Note: Actual prompts/inference content is uploaded separately via presigned URLs
        const sessions = req.body.variables?.sessions || []
        for (const session of sessions) {
          console.log(
            `  ✅ [Mock] Captured inference upload init: model=${session.model || 'unknown'}, tool=${session.toolName || 'unknown'}`
          )
          this.uploads.push({
            tool: session.toolName || 'Cursor',
            model: session.model || 'unknown',
            inference: '', // Content uploaded separately
            responseTime: session.aiResponseAt || '',
            prompts: [], // Content uploaded separately
          })
        }
        // Return correct response structure matching what the upload code expects
        res.json({
          data: {
            uploadAIBlameInferencesInit: {
              status: 'OK',
              error: null,
              uploadSessions: sessions.map(
                (
                  _s: unknown,
                  i: number
                ): {
                  aiBlameInferenceId: string
                  prompt: {
                    url: string | null
                    uploadFieldsJSON: string
                    uploadKey: string
                  }
                  inference: {
                    url: string | null
                    uploadFieldsJSON: string
                    uploadKey: string
                  }
                } => ({
                  aiBlameInferenceId: `test-inference-id-${i}`,
                  prompt: {
                    url: `http://localhost:${this.port}/mock-s3-upload`,
                    uploadFieldsJSON: '{}',
                    uploadKey: `test-prompt-key-${i}`,
                  },
                  inference: {
                    url: `http://localhost:${this.port}/mock-s3-upload`,
                    uploadFieldsJSON: '{}',
                    uploadKey: `test-inference-key-${i}`,
                  },
                })
              ),
            },
          },
        })
      } else if (operationName === 'FinalizeAIBlameInferencesUpload') {
        res.json({
          data: {
            finalizeAIBlameInferencesUpload: {
              status: 'OK',
              error: null,
            },
          },
        })
      } else {
        // Generic response for unknown operations - try to respond successfully
        console.log(`  [Mock] Returning generic success for: ${operationName}`)
        res.json({
          data: {
            [operationName]: true,
          },
        })
      }
  }

  private handleS3Upload(req: express.Request, res: express.Response) {
    // Extract key and file content from multipart form data
    const body = req.body as Buffer
    const bodyStr = body?.toString('utf-8') || ''

    // Parse multipart boundary from content-type header
    const contentType = req.headers['content-type'] || ''
    const boundaryMatch = contentType.match(/boundary=(.+)/)
    const boundary = boundaryMatch ? boundaryMatch[1] : null

    let uploadKey = ''
    let fileContent = ''

    if (boundary && bodyStr) {
      // Split by boundary and find parts
      const parts = bodyStr.split(`--${boundary}`)
      for (const part of parts) {
        // Extract key from form field
        if (part.includes('name="key"')) {
          const keyMatch = part.match(/name="key"\r\n\r\n([^\r\n]+)/)
          if (keyMatch) {
            uploadKey = keyMatch[1]
          }
        }
        // Extract file content
        if (part.includes('name="file"')) {
          // Content comes after double CRLF
          const contentStart = part.indexOf('\r\n\r\n')
          if (contentStart !== -1) {
            // Remove trailing boundary markers
            fileContent = part
              .slice(contentStart + 4)
              .replace(/\r\n--.*$/, '')
              .trim()
          }
        }
      }
    }

    if (uploadKey && fileContent) {
      this.s3Uploads.set(uploadKey, fileContent)
      console.log(
        `  ✅ [Mock] Captured S3 upload: key=${uploadKey}, content=${fileContent.substring(0, 100)}...`
      )
    } else {
      console.log(
        `  [Mock] Received S3-style file upload (key=${uploadKey || 'unknown'}, content length=${fileContent.length})`
      )
    }

    // Return 204 No Content (what S3 returns on success)
    res.status(204).send()
  }

  private handleRestUpload(req: express.Request, res: express.Response) {
      const upload = req.body as InferenceUpload
      console.log(
        `  ✅ [Mock] Captured inference upload: model=${upload.model}, prompts=${upload.prompts?.length || 0}`
      )
      this.uploads.push(upload)
      res.json({ success: true, id: `test-inference-${Date.now()}` })
  }

  private handleHealthCheck(req: express.Request, res: express.Response) {
    res.json({
      status: 'ok',
      uploads: this.uploads.length,
      requests: this.requestLog.length,
    })
  }

  private handleDebugUploads(req: express.Request, res: express.Response) {
    res.json(this.uploads)
  }

  private handleDebugRequests(req: express.Request, res: express.Response) {
    res.json(this.requestLog)
  }

  private async handleCopilotAuth(req: express.Request, res: express.Response) {
    const authUrl = req.body.url
    console.log('🔐 [Mock] Copilot auth URL captured:', authUrl)

    if (this.copilotAuthCallback) {
      try {
        await this.copilotAuthCallback(authUrl)
        res.json({ success: true })
      } catch (error) {
        console.error('❌ [Mock] Copilot auth callback failed:', error)
        res.status(500).json({ success: false, error: String(error) })
      }
    } else {
      console.log('⚠️  [Mock] No Copilot auth callback registered')
      res.json({ success: false, error: 'No callback registered' })
    }
  }

  private handleMcpTracking(req: express.Request, res: express.Response) {
    console.log('  [Mock] MCP tracking request received')
    res.json({
      success: true,
      message: 'MCP tracking recorded',
      organizationId: req.body.organizationId || 'test-org-id',
    })
  }

  private handleUnknownRoute(req: express.Request, res: express.Response) {
    console.log(`  [Mock] ⚠️  UNHANDLED REQUEST: ${req.method} ${req.path}`)
    console.log(
      `  [Mock]   Body: ${JSON.stringify(req.body).substring(0, 500)}`
    )
    res.status(200).json({ success: true })
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Server Lifecycle Methods
  // ═══════════════════════════════════════════════════════════════════════════

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        console.log(`🚀 Mock upload server listening on port ${this.port}`)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve()
        return
      }
      this.server.close((err) => {
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      })
    })
  }

  getCapturedUploads(): InferenceUpload[] {
    return this.uploads
  }

  getS3Uploads(): Map<string, string> {
    return this.s3Uploads
  }

  getRequestLog(): Array<{ method: string; path: string; body: any }> {
    return this.requestLog
  }

  clearUploads(): void {
    this.uploads = []
  }

  clearRequestLog(): void {
    this.requestLog = []
  }

  clearAll(): void {
    this.clearUploads()
    this.clearRequestLog()
    this.s3Uploads.clear()
  }

  async waitForUploads(
    count: number,
    options: { timeout: number; logInterval?: number }
  ): Promise<void> {
    const startTime = Date.now()
    const checkInterval = 1000 // Check every second
    const logInterval = options.logInterval ?? 5000 // Log progress every 5 seconds
    let lastLogTime = 0

    console.log(
      `  ⏳ [Mock] Waiting for ${count} upload(s) (timeout: ${options.timeout / 1000}s)...`
    )

    while (this.uploads.length < count) {
      const elapsed = Date.now() - startTime

      if (elapsed > options.timeout) {
        // Detailed timeout error with GraphQL operations breakdown
        const graphqlOps = this.requestLog
          .filter((r) => r.path === '/graphql')
          .map((r) => r.body?.operationName || 'unknown')
        const opCounts: Record<string, number> = {}
        for (const op of graphqlOps) {
          opCounts[op] = (opCounts[op] || 0) + 1
        }

        throw new Error(
          `Timeout waiting for ${count} uploads. Got ${this.uploads.length} after ${options.timeout}ms.\n` +
            `Total requests: ${this.requestLog.length}\n` +
            `GraphQL operations: ${JSON.stringify(opCounts, null, 2)}\n` +
            `Request log: ${JSON.stringify(
              this.requestLog.map((r) => `${r.method} ${r.path}`),
              null,
              2
            )}`
        )
      }

      // Log progress periodically
      if (elapsed - lastLogTime >= logInterval) {
        console.log(
          `  📊 [Mock] Progress: ${this.uploads.length}/${count} uploads, ${Math.round(elapsed / 1000)}s elapsed, ${this.requestLog.length} total requests`
        )
        lastLogTime = elapsed
      }

      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }

    console.log(
      `  ✅ [Mock] Received ${this.uploads.length} uploads in ${Math.round((Date.now() - startTime) / 1000)}s`
    )
  }

  getPort(): number {
    return this.port
  }
}

// Standalone server mode (for manual testing)
if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || '3000', 10)
  const server = new MockUploadServer(port)

  server.start().then(() => {
    console.log(`Mock server running on http://localhost:${port}`)
    console.log(`Health check: http://localhost:${port}/health`)
    console.log(`View uploads: http://localhost:${port}/debug/uploads`)
    console.log(`View requests: http://localhost:${port}/debug/requests`)
  })

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down mock server...')
    await server.stop()
    process.exit(0)
  })
}
