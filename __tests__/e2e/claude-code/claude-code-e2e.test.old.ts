import { ChildProcess, execSync, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { initGitRepository } from '../shared/git-utils.js'
import { MockUploadServer } from '../shared/mock-server.js'
import { CheckpointTracker } from '../shared/test-utilities.js'

// Test configuration
const UPLOAD_WAIT_TIMEOUT = 30000 // 30 seconds for upload
const CLAUDE_CODE_TIMEOUT = 60000 // 60 seconds for Claude Code to respond

// Initialize checkpoint tracker
const tracker = new CheckpointTracker([
  'Claude Code Installed',
  'AWS Bedrock Configured',
  'Mobb Hook Installed',
  'Mock Server Running',
  'Claude Code Prompt Sent',
  'Code Generated',
  'Hook Captured Attribution',
  'Attribution Uploaded',
])

type ClaudeCodeSettings = {
  hooks?: {
    PostToolUse?: Array<{
      matcher: string
      hooks: Array<{
        type: string
        command: string
      }>
    }>
  }
  [key: string]: unknown
}

async function runClaudeCodeE2ETest(): Promise<void> {
  testStartTime = Date.now()
  tracker.logTimestamp('Test started')

  let mockServer: MockUploadServer | null = null
  let claudeProcess: ChildProcess | null = null
  let testWorkspaceDir: string | null = null
  let claudeSettingsBackup: string | null = null

  try {
    // ==== Step 1: Verify Claude Code is installed ====
    tracker.logTimestamp('Verifying Claude Code installation')
    try {
      const version = execSync('claude --version', { encoding: 'utf-8' })
      console.log(`  Claude Code version: ${version.trim()}`)
      tracker.mark('Claude Code Installed')
    } catch (error) {
      console.error('❌ Claude Code is not installed')
      console.error('   Install with: npm install -g @anthropic-ai/claude-code')
      throw new Error('Claude Code not found')
    }

    // ==== Step 2: Verify AWS Bedrock configuration ====
    tracker.logTimestamp('Checking AWS Bedrock configuration')
    const hasAwsCredentials =
      process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    const hasBedrockToken = process.env.AWS_BEARER_TOKEN_BEDROCK
    const hasAnthropicKey = process.env.ANTHROPIC_API_KEY

    if (hasBedrockToken) {
      console.log('  ✅ AWS Bedrock bearer token found')
      console.log(`     Region: ${process.env.AWS_REGION || 'us-west-2'}`)
      tracker.mark('AWS Bedrock Configured')
    } else if (hasAwsCredentials) {
      console.log('  ✅ AWS Bedrock credentials found')
      console.log(
        `     Region: ${process.env.AWS_DEFAULT_REGION || 'us-west-2'}`
      )
      tracker.mark('AWS Bedrock Configured')
    } else if (hasAnthropicKey) {
      console.log('  ✅ Anthropic API key found (fallback)')
      tracker.mark('AWS Bedrock Configured')
    } else {
      console.error('❌ No API credentials found')
      console.error(
        '   Set AWS_BEARER_TOKEN_BEDROCK (for Bedrock bearer token)'
      )
      console.error('   Or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY')
      console.error('   Or ANTHROPIC_API_KEY')
      throw new Error('API credentials are required to run E2E tests')
    }

    // ==== Step 3: Start mock server ====
    tracker.logTimestamp('Starting mock server')
    mockServer = new MockUploadServer(3000)
    await mockServer.start()
    console.log('  Mock server started on port 3000')
    tracker.mark('Mock Server Running')

    // ==== Step 4: Create test workspace ====
    tracker.logTimestamp('Creating test workspace')
    testWorkspaceDir = path.join(os.tmpdir(), `claude-code-e2e-${Date.now()}`)
    fs.mkdirSync(testWorkspaceDir, { recursive: true })

    // Create initial file before git init
    fs.writeFileSync(
      path.join(testWorkspaceDir, 'index.js'),
      '// Test file\nconsole.log("Hello");\n'
    )

    // Initialize git repo (required for Claude Code)
    await initGitRepository(testWorkspaceDir, {
      commitMessage: 'Initial commit',
    })

    console.log(`  Workspace created: ${testWorkspaceDir}`)

    // ==== Step 5: Install Mobb hook in Claude Code settings ====
    tracker.logTimestamp('Installing Mobb hook')
    const claudeSettingsPath = path.join(
      os.homedir(),
      '.claude',
      'settings.json'
    )

    // Ensure .claude directory exists
    fs.mkdirSync(path.dirname(claudeSettingsPath), { recursive: true })

    // Backup existing settings if any
    if (fs.existsSync(claudeSettingsPath)) {
      claudeSettingsBackup = fs.readFileSync(claudeSettingsPath, 'utf-8')
    }

    // Create settings with Mobb hook pointing to mock server
    const hookCommand = `API_URL="http://localhost:3000/graphql" npx mobbdev claude-code-process-hook`
    const settings: ClaudeCodeSettings = {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Edit|Write',
            hooks: [
              {
                type: 'command',
                command: hookCommand,
              },
            ],
          },
        ],
      },
    }

    fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2))
    console.log(`  Hook installed: ${hookCommand}`)
    tracker.mark('Mobb Hook Installed')

    // ==== Step 6: Run Claude Code with a prompt ====
    tracker.logTimestamp('Running Claude Code')

    const prompt =
      'Create a file called utils.js with a function that adds two numbers'

    console.log(`  Prompt: "${prompt}"`)
    console.log(`  Working directory: ${testWorkspaceDir}`)

    // Run Claude Code in print mode (non-interactive)
    // --permission-mode bypassPermissions skips permission prompts for automated testing
    // --debug enables debug output which also fixes some initialization issues
    // Inherit all env vars including AWS_BEARER_TOKEN_BEDROCK, CLAUDE_CODE_USE_BEDROCK, etc.
    claudeProcess = spawn(
      'claude',
      ['--print', '--debug', '--permission-mode', 'bypassPermissions', prompt],
      {
        cwd: testWorkspaceDir,
        env: {
          ...process.env,
          // Point API to mock server for any GraphQL calls from the hook
          API_URL: 'http://localhost:3000/graphql',
        },
        // Use inherit for stdio to avoid buffering issues and see real-time output
        stdio: 'inherit',
      }
    )

    tracker.mark('Claude Code Prompt Sent')

    // stderr for error reporting (captured from exit code since stdio is inherited)
    const stderr = 'See console output above'

    // Wait for Claude Code to complete
    const exitCode = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        claudeProcess?.kill('SIGKILL')
        reject(
          new Error(`Claude Code timed out after ${CLAUDE_CODE_TIMEOUT}ms`)
        )
      }, CLAUDE_CODE_TIMEOUT)

      claudeProcess?.on('close', (code) => {
        clearTimeout(timeout)
        resolve(code ?? 1)
      })

      claudeProcess?.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    })

    tracker.logTimestamp(`Claude Code exited with code ${exitCode}`)

    if (exitCode !== 0) {
      console.error('  ❌ Claude Code failed')
      console.error(`  stderr: ${stderr}`)
      throw new Error(`Claude Code exited with code ${exitCode}`)
    }

    // Check if code was generated
    const generatedFile = path.join(testWorkspaceDir, 'utils.js')
    if (fs.existsSync(generatedFile)) {
      console.log('  ✅ File generated: utils.js')
      const content = fs.readFileSync(generatedFile, 'utf-8')
      console.log(`  Content preview: ${content.substring(0, 100)}...`)
      tracker.mark('Code Generated')
    } else {
      console.log('  ⚠️  utils.js not found, checking other generated files...')
      const files = fs.readdirSync(testWorkspaceDir)
      console.log(`  Files in workspace: ${files.join(', ')}`)
    }

    // ==== Step 7: Wait for hook to capture and upload attribution ====
    tracker.logTimestamp('Waiting for attribution upload')
    console.log(`  Timeout: ${UPLOAD_WAIT_TIMEOUT / 1000}s`)

    try {
      await mockServer.waitForUploads(1, {
        timeout: UPLOAD_WAIT_TIMEOUT,
        logInterval: 5000,
      })
      tracker.mark('Hook Captured Attribution')
    } catch (uploadError) {
      console.error('  ❌ No attribution received')
      console.error(
        `  Total mock server requests: ${mockServer.getRequestLog().length}`
      )

      // Log what requests we did receive
      const requests = mockServer.getRequestLog()
      for (const req of requests) {
        console.log(`    ${req.method} ${req.path}`)
      }

      throw uploadError
    }

    // ==== Step 8: Validate upload ====
    tracker.logTimestamp('Validating attribution upload')
    const uploads = mockServer.getCapturedUploads()

    if (uploads.length === 0) {
      throw new Error('No uploads captured by mock server')
    }

    console.log(`  Uploads received: ${uploads.length}`)

    const upload = uploads[0]
    console.log(`  Tool: ${upload.tool}`)
    console.log(`  Model: ${upload.model}`)
    console.log(`  Response time: ${upload.responseTime}`)

    // Validate expected fields
    if (upload.tool !== 'Claude Code') {
      console.warn(
        `  ⚠️  Unexpected tool: ${upload.tool} (expected: Claude Code)`
      )
    }

    tracker.mark('Attribution Uploaded')

    // ==== Success ====
    tracker.logTimestamp('Test completed successfully')
    tracker.printSummary()
  } catch (error) {
    console.error('')
    console.error('❌ TEST FAILED:', error)
    tracker.printSummary()
    throw error
  } finally {
    // Cleanup
    tracker.logTimestamp('Cleanup')

    // Gracefully shut down Claude process if still running
    if (claudeProcess && !claudeProcess.killed) {
      try {
        // Try graceful shutdown first (SIGTERM)
        claudeProcess.kill('SIGTERM')

        // Wait up to 5 seconds for graceful shutdown
        const shutdownTimeout = setTimeout(() => {
          if (claudeProcess && !claudeProcess.killed) {
            console.log('  ⚠️  Graceful shutdown timed out, forcing kill (SIGKILL)')
            claudeProcess.kill('SIGKILL')
          }
        }, 5000)

        // Clear timeout if process exits cleanly
        claudeProcess.on('exit', () => clearTimeout(shutdownTimeout))
      } catch (err) {
        console.log(`  ⚠️  Error during process shutdown: ${err}`)
      }
    }

    // Stop mock server
    if (mockServer) {
      await mockServer.stop()
    }

    // Restore Claude settings
    const claudeSettingsPath = path.join(
      os.homedir(),
      '.claude',
      'settings.json'
    )
    if (claudeSettingsBackup !== null) {
      fs.writeFileSync(claudeSettingsPath, claudeSettingsBackup)
    } else if (fs.existsSync(claudeSettingsPath)) {
      fs.unlinkSync(claudeSettingsPath)
    }

    // Cleanup test workspace
    if (testWorkspaceDir && fs.existsSync(testWorkspaceDir)) {
      try {
        fs.rmSync(testWorkspaceDir, { recursive: true, force: true })
      } catch (cleanupError) {
        console.log('  ⚠️  Could not cleanup workspace:', cleanupError)
      }
    }

    tracker.logTimestamp('Cleanup complete')
  }
}

// Run the test
runClaudeCodeE2ETest()
  .then(() => {
    console.log('')
    console.log('✅ E2E TEST PASSED')
    process.exit(0)
  })
  .catch((error) => {
    console.error('')
    console.error('❌ E2E TEST FAILED:', error.message)
    process.exit(1)
  })
