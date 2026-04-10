import { ChildProcess, execSync, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { initGitRepository } from '../shared/git-utils'
import { MockUploadServer } from '../shared/mock-server'
import { CheckpointTracker } from '../shared/test-utilities'

// Test configuration
const CLI_DIST = path.resolve(__dirname, '../../../../cli/dist/index.mjs')
const UPLOAD_WAIT_TIMEOUT = 30000
const CLAUDE_CODE_TIMEOUT = 120000 // 2 minutes — prompt includes a 15s sleep
const TEST_TIMEOUT = 180000 // 3 minutes total

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

describe('Claude Code E2E — Multi-Turn Incremental Cursor', () => {
  let mockServer: MockUploadServer | null = null
  let claudeProcess: ChildProcess | null = null
  let testWorkspaceDir: string | null = null
  let claudeSettingsBackup: string | null = null

  const tracker = new CheckpointTracker([
    'Claude Code Installed',
    'API Credentials Configured',
    'Mock Server Running',
    'Mobb Hook Installed',
    'Claude Code Prompt Sent',
    'Both Files Created',
    'Two Upload Batches Received',
    'No Overlapping Records Between Batches',
    'No Duplicate Records',
  ])

  afterEach(async () => {
    tracker.logTimestamp('Cleanup')

    if (claudeProcess && !claudeProcess.killed) {
      try {
        claudeProcess.kill('SIGTERM')
        const shutdownTimeout = setTimeout(() => {
          if (claudeProcess && !claudeProcess.killed) {
            claudeProcess.kill('SIGKILL')
          }
        }, 5000)
        claudeProcess.on('exit', () => clearTimeout(shutdownTimeout))
      } catch (err) {
        console.log(`  Warning: process shutdown error: ${err}`)
      }
    }

    // Kill daemon if running
    try {
      const pidData = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.mobbdev', 'daemon.pid'), 'utf8'))
      process.kill(pidData.pid, 'SIGKILL')
    } catch { /* already dead or no pid file */ }

    if (mockServer) {
      await mockServer.stop()
    }

    const claudeSettingsPath = path.join(
      os.homedir(),
      '.claude',
      'settings.json'
    )
    if (claudeSettingsBackup !== null) {
      fs.writeFileSync(claudeSettingsPath, claudeSettingsBackup)
    }

    if (testWorkspaceDir && fs.existsSync(testWorkspaceDir)) {
      try {
        fs.rmSync(testWorkspaceDir, { recursive: true, force: true })
      } catch (cleanupError) {
        console.log(`  Warning: could not cleanup workspace: ${cleanupError}`)
      }
    }

    tracker.logTimestamp('Cleanup complete')
    tracker.printSummary()
  })

  it(
    'should upload incrementally via cursor — no duplicate records across hook fires',
    async () => {
      // Kill any stale daemon from a previous test run
      try {
        const pidData = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.mobbdev', 'daemon.pid'), 'utf8'))
        process.kill(pidData.pid, 'SIGKILL')
      } catch { /* no stale daemon */ }

      tracker.logTimestamp('Test started')

      // ==== Step 1: Verify Claude Code is installed ====
      try {
        const version = execSync('claude --version', { encoding: 'utf-8' })
        console.log(`  Claude Code version: ${version.trim()}`)
        tracker.mark('Claude Code Installed')
      } catch {
        throw new Error(
          'Claude Code not found. Install with: npm install -g @anthropic-ai/claude-code'
        )
      }

      // ==== Step 2: Verify API credentials ====
      const hasCredentials =
        process.env.AWS_BEARER_TOKEN_BEDROCK ||
        (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
        process.env.ANTHROPIC_API_KEY

      if (!hasCredentials) {
        throw new Error(
          'API credentials required (AWS_BEARER_TOKEN_BEDROCK, AWS keys, or ANTHROPIC_API_KEY)'
        )
      }
      tracker.mark('API Credentials Configured')

      // ==== Step 3: Start mock server ====
      mockServer = new MockUploadServer(3001) // Use 3001 to avoid conflicts
      await mockServer.start()
      console.log('  Mock server started on port 3001')
      tracker.mark('Mock Server Running')

      // ==== Step 4: Create test workspace ====
      testWorkspaceDir = path.join(
        os.tmpdir(),
        `claude-code-multi-turn-e2e-${Date.now()}`
      )
      fs.mkdirSync(testWorkspaceDir, { recursive: true })
      fs.writeFileSync(
        path.join(testWorkspaceDir, 'index.js'),
        '// Test workspace\nconsole.log("Hello");\n'
      )
      await initGitRepository(testWorkspaceDir, {
        commitMessage: 'Initial commit',
      })
      console.log(`  Workspace: ${testWorkspaceDir}`)

      // ==== Step 5: Install Mobb hook ====
      const claudeSettingsPath = path.join(
        os.homedir(),
        '.claude',
        'settings.json'
      )
      fs.mkdirSync(path.dirname(claudeSettingsPath), { recursive: true })
      if (fs.existsSync(claudeSettingsPath)) {
        claudeSettingsBackup = fs.readFileSync(claudeSettingsPath, 'utf-8')
      }

      const hookCommand = `API_URL="http://localhost:3001/graphql" npx mobbdev claude-code-process-hook`
      const settings: ClaudeCodeSettings = {
        hooks: {
          PostToolUse: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: hookCommand }],
            },
          ],
        },
      }
      fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2))
      tracker.mark('Mobb Hook Installed')

      // ==== Step 6: Run Claude Code with a multi-tool prompt ====
      // The prompt forces two Write tool uses with a 15s sleep in between,
      // ensuring the hook fires twice past the 10s per-session cooldown.
      const prompt = [
        'Do exactly these 3 steps in order:',
        '1. Create a file called utils.js with: module.exports = { add: (a, b) => a + b };',
        '2. Run the shell command: sleep 15',
        '3. Create a file called math.js with: module.exports = { multiply: (a, b) => a * b };',
        'Do not create any other files. Do not explain anything.',
      ].join(' ')

      console.log(`  Prompt: "${prompt}"`)
      tracker.logTimestamp('Spawning Claude Code')

      claudeProcess = spawn(
        'claude',
        [
          '--print',
          '--debug',
          '--permission-mode',
          'bypassPermissions',
          prompt,
        ],
        {
          cwd: testWorkspaceDir,
          env: {
            ...process.env,
            API_URL: 'http://localhost:3001/graphql',
            MOBBDEV_LOCAL_CLI: CLI_DIST,
            // Unset CLAUDECODE to avoid "nested session" rejection when
            // running this test from within a Claude Code session.
            CLAUDECODE: '',
          },
          stdio: ['ignore', 'inherit', 'inherit'],
        }
      )

      tracker.mark('Claude Code Prompt Sent')

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
      expect(exitCode).toBe(0)

      // Check both files were created
      const utilsExists = fs.existsSync(
        path.join(testWorkspaceDir, 'utils.js')
      )
      const mathExists = fs.existsSync(
        path.join(testWorkspaceDir, 'math.js')
      )
      console.log(`  utils.js exists: ${utilsExists}`)
      console.log(`  math.js exists: ${mathExists}`)
      if (utilsExists && mathExists) {
        tracker.mark('Both Files Created')
      }
      expect(utilsExists).toBe(true)
      expect(mathExists).toBe(true)

      // ==== Step 7: Wait for TWO distinct UploadTracyRecords calls ====
      // The prompt triggers: Write(utils.js) → Bash(sleep 15) → Write(math.js).
      // Hook fires on each PostToolUse. The first Write triggers upload batch #1.
      // Bash(sleep 15) fires the hook too, but may be within cooldown (skipped).
      // After 15s the cooldown has expired, so Write(math.js) triggers batch #2,
      // which reads from the cursor offset — uploading only NEW transcript entries.
      tracker.logTimestamp('Waiting for 2 distinct upload batches')
      await mockServer.waitForTracyBatches(2, {
        timeout: 60000, // 60s — accounts for 15s sleep + processing
        logInterval: 5000,
      })
      tracker.mark('Two Upload Batches Received')

      const batches = mockServer.getTracyBatches()
      console.log(`  Total batches: ${batches.length}`)
      for (let i = 0; i < batches.length; i++) {
        console.log(
          `  Batch #${i + 1}: ${batches[i].length} records (IDs: ${batches[i].map((r) => r.recordId.slice(0, 8)).join(', ')})`
        )
      }

      // ==== Step 8: Validate no overlapping record IDs between batches ====
      // The cursor advances after each successful upload, so batch #2 must
      // contain only entries that appeared in the transcript AFTER batch #1.
      const batch1Ids = new Set(batches[0].map((r) => r.recordId))
      const batch2Ids = new Set(batches[1].map((r) => r.recordId))

      const overlap = [...batch2Ids].filter((id) => batch1Ids.has(id))
      if (overlap.length > 0) {
        console.log(
          `  OVERLAP between batches: ${overlap.join(', ')}`
        )
      } else {
        console.log('  No overlapping record IDs between batches')
      }

      expect(overlap).toHaveLength(0)
      tracker.mark('No Overlapping Records Between Batches')

      // ==== Step 9: Validate all records globally unique ====
      const allRecords = mockServer.getCapturedTracyRecords()
      const allIds = allRecords.map((r) => r.recordId)
      const uniqueIds = new Set(allIds)
      console.log(
        `  Total records: ${allIds.length}, unique: ${uniqueIds.size}`
      )
      expect(uniqueIds.size).toBe(allIds.length)
      tracker.mark('No Duplicate Records')

      // ==== Step 10: Validate record contents ====
      const s3Uploads = mockServer.getS3Uploads()
      for (const record of allRecords.slice(0, 3)) {
        expect(record.platform).toBe('CLAUDE_CODE')
        expect(record.recordId).toBeTruthy()
        expect(record.rawDataS3Key).toBeTruthy()

        // rawData is uploaded to S3 via presigned URL — retrieve from mock S3 store
        const s3Content = s3Uploads.get(record.rawDataS3Key!)
        expect(s3Content, `S3 upload not found for key: ${record.rawDataS3Key}`).toBeTruthy()

        const parsed = JSON.parse(s3Content!) as Record<string, unknown>
        expect(parsed.type).toBeTruthy()
        expect([
          'user',
          'assistant',
          'system',
          'summary',
          'progress',
          'attachment',
        ]).toContain(parsed.type)
      }

      tracker.logTimestamp('Test completed successfully')
    },
    { timeout: TEST_TIMEOUT }
  )
})
