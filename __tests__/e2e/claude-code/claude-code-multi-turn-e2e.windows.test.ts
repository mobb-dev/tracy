import { ChildProcess, execSync, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { initGitRepository } from '../shared/git-utils'
import { MockUploadServer } from '../shared/mock-server'
import { MOCK_SERVER_MULTI_TURN_PORT } from '../shared/test-config'
import { CheckpointTracker } from '../shared/test-utilities'
import {
  assertPortFree,
  type ClaudeCodeSettings,
  getWindowsTempBase,
  killProcessTree,
  logDirectoryContents,
  logRelevantEnvVars,
  logWindowsEnvironment,
} from '../shared/windows-helpers'

const MULTI_TURN_API_URL = `http://localhost:${MOCK_SERVER_MULTI_TURN_PORT}/graphql`

// Test configuration
const CLI_DIST = path.resolve(__dirname, '../../../../cli/dist/index.mjs')
const UPLOAD_WAIT_TIMEOUT = 30000
const CLAUDE_CODE_TIMEOUT = 120000 // 2 minutes — prompt includes a 15s sleep
const TEST_TIMEOUT = 180000 // 3 minutes total

// Only run on Windows — skipped automatically on Linux containers
describe.skipIf(process.platform !== 'win32')('Claude Code E2E — Multi-Turn Incremental Cursor (Windows)', () => {
  let mockServer: MockUploadServer | null = null
  let claudeProcess: ChildProcess | null = null
  let testWorkspaceDir: string | null = null
  let claudeSettingsBackup: string | null = null
  let claudeSettingsCreated = false

  // Abnormal-exit cleanup — mirror the single-turn test's SIGINT/SIGTERM
  // handler so a crash doesn't leak the test's settings.json onto a real host.
  const claudeSettingsPath = path.join(
    os.homedir(),
    '.claude',
    'settings.json'
  )
  const restoreClaudeSettingsSync = (): void => {
    try {
      if (claudeSettingsBackup !== null) {
        fs.writeFileSync(claudeSettingsPath, claudeSettingsBackup)
      } else if (claudeSettingsCreated && fs.existsSync(claudeSettingsPath)) {
        fs.unlinkSync(claudeSettingsPath)
      }
    } catch {
      /* best-effort only during abnormal exit */
    }
  }
  const abnormalExitHandler = (): void => {
    restoreClaudeSettingsSync()
  }
  process.once('SIGINT', abnormalExitHandler)
  process.once('SIGTERM', abnormalExitHandler)
  process.once('exit', abnormalExitHandler)

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
    tracker.logTimestamp('Cleanup started')

    // Log final mock server state
    if (mockServer) {
      const records = mockServer.getCapturedTracyRecords()
      const s3 = mockServer.getS3Uploads()
      try {
        const batches = mockServer.getTracyBatches()
        console.log(`  [cleanup] Mock server final state: ${records.length} records, ${batches.length} batches, ${s3.size} S3 uploads`)
      } catch {
        console.log(`  [cleanup] Mock server final state: ${records.length} records, ${s3.size} S3 uploads`)
      }
    }

    if (claudeProcess && !claudeProcess.killed && claudeProcess.pid) {
      console.log(`  [cleanup] Killing Claude process (pid: ${claudeProcess.pid})`)
      killProcessTree(claudeProcess.pid)
    }

    // Kill daemon if running
    const daemonPidPath = path.join(os.homedir(), '.mobbdev', 'daemon.pid')
    try {
      const pidData = JSON.parse(fs.readFileSync(daemonPidPath, 'utf8'))
      console.log(`  [cleanup] Killing daemon (pid: ${pidData.pid})`)
      killProcessTree(pidData.pid)
    } catch {
      console.log(`  [cleanup] No daemon pid file at ${daemonPidPath}`)
    }

    if (mockServer) {
      console.log('  [cleanup] Stopping mock server')
      await mockServer.stop()
    }

    if (claudeSettingsBackup !== null) {
      console.log(`  [cleanup] Restoring Claude settings at ${claudeSettingsPath}`)
      fs.writeFileSync(claudeSettingsPath, claudeSettingsBackup)
    } else if (claudeSettingsCreated && fs.existsSync(claudeSettingsPath)) {
      console.log(`  [cleanup] Deleting test-created Claude settings at ${claudeSettingsPath}`)
      fs.unlinkSync(claudeSettingsPath)
    }
    claudeSettingsCreated = false
    claudeSettingsBackup = null

    if (testWorkspaceDir && fs.existsSync(testWorkspaceDir)) {
      console.log(`  [cleanup] Removing workspace: ${testWorkspaceDir}`)
      try {
        fs.rmSync(testWorkspaceDir, { recursive: true, force: true })
      } catch (cleanupError) {
        console.log(`  [cleanup] Could not cleanup workspace: ${cleanupError}`)
      }
    }

    tracker.logTimestamp('Cleanup complete')
    tracker.printSummary()
  })

  it(
    'should upload incrementally via cursor — no duplicate records across hook fires',
    async () => {
      const testStart = Date.now()

      // Kill any stale daemon from a previous test run
      try {
        const pidData = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.mobbdev', 'daemon.pid'), 'utf8'))
        console.log(`  [pre-test] Killing stale daemon (pid: ${pidData.pid})`)
        killProcessTree(pidData.pid)
      } catch { /* no stale daemon */ }

      tracker.logTimestamp('Test started')

      // ==== Step 0: Log Windows environment ====
      console.log('')
      console.log('  =============================================')
      console.log('  WINDOWS E2E TEST — MULTI-TURN')
      console.log('  =============================================')
      logWindowsEnvironment({ CLI_DIST, 'CLI_DIST exists': String(fs.existsSync(CLI_DIST)) })
      logRelevantEnvVars()
      console.log('')

      // ==== Step 1: Verify Claude Code is installed ====
      tracker.logTimestamp('Verifying Claude Code')
      try {
        const version = execSync('claude --version', { encoding: 'utf-8' })
        console.log(`  Claude Code version: ${version.trim()}`)

        try {
          const whereClaude = execSync('where claude', { encoding: 'utf-8' })
          console.log(`  Claude binary: ${whereClaude.trim()}`)
        } catch { /* where not available */ }

        tracker.mark('Claude Code Installed')
      } catch (error) {
        console.error(`  FATAL: Claude Code not found: ${error}`)
        throw new Error(
          'Claude Code not found. Install with: npm install -g @anthropic-ai/claude-code'
        )
      }

      // Verify mobbdev
      try {
        const mobbdevVersion = execSync('mobbdev --version', { encoding: 'utf-8' })
        console.log(`  Mobbdev CLI version: ${mobbdevVersion.trim()}`)
      } catch {
        console.log('  WARNING: mobbdev CLI not found in PATH')
      }

      // ==== Step 2: Verify API credentials ====
      tracker.logTimestamp('Checking API credentials')
      const hasCredentials =
        process.env.AWS_BEARER_TOKEN_BEDROCK ||
        (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
        process.env.ANTHROPIC_API_KEY

      if (!hasCredentials) {
        console.error('  FATAL: No API credentials found')
        console.error('  Checked: AWS_BEARER_TOKEN_BEDROCK, AWS_ACCESS_KEY_ID+SECRET, ANTHROPIC_API_KEY')
        throw new Error(
          'API credentials required (AWS_BEARER_TOKEN_BEDROCK, AWS keys, or ANTHROPIC_API_KEY)'
        )
      }
      console.log('  API credentials found')
      tracker.mark('API Credentials Configured')

      // ==== Step 3: Start mock server ====
      tracker.logTimestamp(`Starting mock server on port ${MOCK_SERVER_MULTI_TURN_PORT}`)

      // Fail fast if the port is bound — a collision would make the later
      // "two upload batches" wait time out with no useful diagnostic.
      await assertPortFree(MOCK_SERVER_MULTI_TURN_PORT)

      // Multi-turn uses a distinct port so it can run alongside the single-turn test.
      mockServer = new MockUploadServer(MOCK_SERVER_MULTI_TURN_PORT)
      await mockServer.start()
      console.log(`  Mock server started on port ${MOCK_SERVER_MULTI_TURN_PORT}`)
      tracker.mark('Mock Server Running')

      // ==== Step 4: Create test workspace ====
      tracker.logTimestamp('Creating test workspace')
      testWorkspaceDir = path.join(
        getWindowsTempBase(),
        `claude-code-multi-turn-e2e-win-${Date.now()}`
      )
      console.log(`  Target path: ${testWorkspaceDir}`)

      fs.mkdirSync(testWorkspaceDir, { recursive: true })
      fs.writeFileSync(
        path.join(testWorkspaceDir, 'index.js'),
        '// Test workspace\nconsole.log("Hello");\n'
      )
      console.log('  Initializing git repository...')
      await initGitRepository(testWorkspaceDir, {
        commitMessage: 'Initial commit',
      })
      console.log(`  Git dir exists: ${fs.existsSync(path.join(testWorkspaceDir, '.git'))}`)
      logDirectoryContents(testWorkspaceDir, '  Workspace contents')

      // ==== Step 5: Install Mobb hook ====
      tracker.logTimestamp('Installing Mobb hook')
      console.log(`  Settings path: ${claudeSettingsPath}`)
      fs.mkdirSync(path.dirname(claudeSettingsPath), { recursive: true })
      if (fs.existsSync(claudeSettingsPath)) {
        claudeSettingsBackup = fs.readFileSync(claudeSettingsPath, 'utf-8')
        console.log(`  Backed up existing settings (${claudeSettingsBackup.length} bytes)`)
      }

      // Debug hook + Mobb hook. Debug hook dumps PostToolUse event params.
      // Target path is passed via HOOK_DEBUG_FILE env var rather than inlined
      // into `node -e` (Windows backslash + quote escaping is fragile).
      const hookCommand = 'npx mobbdev claude-code-process-hook'
      const hookDebugFile = path.join(testWorkspaceDir, 'hook-debug.log')
      const debugHookCommand = `node -e "const fs=require('fs');const p=process.env.HOOK_DEBUG_FILE;let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const log='--- HOOK FIRED: '+new Date().toISOString()+'\\n'+'ENV KEYS: '+Object.keys(process.env).filter(k=>k.match(/claude|mobb|api|aws/i)).join(', ')+'\\n'+'STDIN: '+d+'\\n\\n';fs.appendFileSync(p,log)})"`
      const settings: ClaudeCodeSettings = {
        hooks: {
          PostToolUse: [
            {
              matcher: '',
              hooks: [
                { type: 'command', command: debugHookCommand },
                { type: 'command', command: hookCommand },
              ],
            },
          ],
        },
      }
      fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2))
      claudeSettingsCreated = claudeSettingsBackup === null
      console.log(`  Hook command: ${hookCommand}`)
      console.log(`  Debug hook file: ${hookDebugFile}`)
      console.log(`  Settings written: ${JSON.stringify(settings, null, 2)}`)
      tracker.mark('Mobb Hook Installed')

      // ==== Step 6: Run Claude Code with a multi-tool prompt ====
      // The prompt forces two Write tool uses with a 15s sleep in between,
      // ensuring the hook fires twice past the 10s per-session cooldown.
      // Uses ping for a 15s delay — avoids double-quote issues with PowerShell
      // that break cmd.exe argument parsing.
      tracker.logTimestamp('Building multi-turn prompt')
      const prompt = [
        'Do exactly these 3 steps in order:',
        '1. Create a file called utils.js with: module.exports = { add: (a, b) => a + b };',
        '2. Run the shell command: ping -n 16 127.0.0.1 > nul',
        '3. Create a file called math.js with: module.exports = { multiply: (a, b) => a * b };',
        'Do not create any other files. Do not explain anything.',
      ].join(' ')

      console.log(`  Prompt: "${prompt}"`)
      console.log(`  Expected flow: Write(utils.js) -> ping wait(~15s) -> Write(math.js)`)
      console.log(`  Expected batches: 2 (one per write, separated by cooldown)`)
      tracker.logTimestamp('Spawning Claude Code')

      // On Windows, `claude` is installed as claude.cmd which spawn() can't
      // resolve directly. Invoke cmd.exe explicitly so Node.js passes each
      // arg correctly to CreateProcess and the prompt stays as one argument.
      const claudeArgs = [
        '--print',
        '--dangerously-skip-permissions',
        '--output-format', 'json',
        '--verbose',
        prompt,
      ]
      console.log(`  Spawn: cmd.exe /c claude (prompt length: ${prompt.length} chars)`)
      console.log(`  Working directory: ${testWorkspaceDir}`)
      console.log(`  API_URL: ${MULTI_TURN_API_URL}`)

      claudeProcess = spawn(
        'cmd.exe',
        ['/c', 'claude', ...claudeArgs],
        {
          cwd: testWorkspaceDir,
          env: {
            ...process.env,
            API_URL: MULTI_TURN_API_URL,
            MOBBDEV_LOCAL_CLI: CLI_DIST,
            // Read by the debug hook — avoids interpolating a Windows path
            // with backslashes into the `node -e` string.
            HOOK_DEBUG_FILE: hookDebugFile,
            // Unset CLAUDECODE to avoid "nested session" rejection when
            // running this test from within a Claude Code session.
            CLAUDECODE: '',
          },
          stdio: ['ignore', 'inherit', 'inherit'],
        }
      )

      console.log(`  Claude process PID: ${claudeProcess.pid}`)
      tracker.mark('Claude Code Prompt Sent')

      const exitCode = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => {
          console.log(`  TIMEOUT: Claude Code did not exit within ${CLAUDE_CODE_TIMEOUT}ms`)
          // SIGKILL kills only the top-level cmd.exe on Windows; the grandchild
          // claude + hooks + daemon keep running. killProcessTree uses taskkill /T.
          if (claudeProcess?.pid) killProcessTree(claudeProcess.pid)
          reject(
            new Error(`Claude Code timed out after ${CLAUDE_CODE_TIMEOUT}ms`)
          )
        }, CLAUDE_CODE_TIMEOUT)

        claudeProcess?.on('close', (code) => {
          clearTimeout(timeout)
          console.log(`  Claude process closed with code: ${code}`)
          resolve(code ?? 1)
        })

        claudeProcess?.on('error', (err) => {
          clearTimeout(timeout)
          console.log(`  Claude process error: ${err}`)
          reject(err)
        })
      })

      tracker.logTimestamp(`Claude Code exited with code ${exitCode}`)
      logDirectoryContents(testWorkspaceDir, '  Workspace after Claude Code')

      // Dump debug hook log
      if (fs.existsSync(hookDebugFile)) {
        const hookLog = fs.readFileSync(hookDebugFile, 'utf-8')
        console.log(`  ┌─ HOOK DEBUG LOG (${hookLog.length} bytes) ────`)
        console.log(hookLog)
        console.log(`  └──────────────────────────────────`)
      } else {
        console.log('  HOOK DEBUG LOG: file not found — hooks did NOT fire')
      }

      expect(exitCode).toBe(0)

      // Check both files were created
      const utilsPath = path.join(testWorkspaceDir, 'utils.js')
      const mathPath = path.join(testWorkspaceDir, 'math.js')
      const utilsExists = fs.existsSync(utilsPath)
      const mathExists = fs.existsSync(mathPath)
      console.log(`  utils.js exists: ${utilsExists}${utilsExists ? ` (${fs.statSync(utilsPath).size}B)` : ''}`)
      console.log(`  math.js exists: ${mathExists}${mathExists ? ` (${fs.statSync(mathPath).size}B)` : ''}`)

      if (utilsExists) {
        console.log(`  utils.js content: ${fs.readFileSync(utilsPath, 'utf-8')}`)
      }
      if (mathExists) {
        console.log(`  math.js content: ${fs.readFileSync(mathPath, 'utf-8')}`)
      }

      if (utilsExists && mathExists) {
        tracker.mark('Both Files Created')
      }
      expect(utilsExists).toBe(true)
      expect(mathExists).toBe(true)

      // ==== Step 7: Wait for TWO distinct UploadTracyRecords calls ====
      // The prompt triggers: Write(utils.js) -> Bash(sleep 15) -> Write(math.js).
      // Hook fires on each PostToolUse. The first Write triggers upload batch #1.
      // Bash(sleep 15) fires the hook too, but may be within cooldown (skipped).
      // After 15s the cooldown has expired, so Write(math.js) triggers batch #2,
      // which reads from the cursor offset — uploading only NEW transcript entries.
      tracker.logTimestamp('Waiting for 2 distinct upload batches')
      console.log(`  Timeout: 60s (accounts for 15s sleep + processing)`)
      console.log(`  Current records: ${mockServer.getCapturedTracyRecords().length}`)

      await mockServer.waitForTracyBatches(2, {
        timeout: 60000, // 60s — accounts for 15s sleep + processing
        logInterval: 5000,
      })
      tracker.mark('Two Upload Batches Received')

      const batches = mockServer.getTracyBatches()
      console.log(`  Total batches: ${batches.length}`)
      for (let i = 0; i < batches.length; i++) {
        console.log(`  ┌─ Batch #${i + 1} ─────────────────────────`)
        console.log(`  │ Records: ${batches[i].length}`)
        for (const r of batches[i]) {
          console.log(`  │   ID: ${r.recordId.slice(0, 12)}... | Platform: ${r.platform} | Type: ${r.editType || '(none)'}`)
        }
        console.log(`  └────────────────────────────────────`)
      }

      // ==== Step 8: Validate no overlapping record IDs between batches ====
      tracker.logTimestamp('Checking for overlaps between batches')
      const batch1Ids = new Set(batches[0].map((r) => r.recordId))
      const batch2Ids = new Set(batches[1].map((r) => r.recordId))

      console.log(`  Batch 1 IDs (${batch1Ids.size}): ${[...batch1Ids].map(id => id.slice(0, 8)).join(', ')}`)
      console.log(`  Batch 2 IDs (${batch2Ids.size}): ${[...batch2Ids].map(id => id.slice(0, 8)).join(', ')}`)

      const overlap = [...batch2Ids].filter((id) => batch1Ids.has(id))
      if (overlap.length > 0) {
        console.log(`  OVERLAP DETECTED: ${overlap.map(id => id.slice(0, 8)).join(', ')}`)
      } else {
        console.log('  No overlapping record IDs between batches')
      }

      expect(overlap).toHaveLength(0)
      tracker.mark('No Overlapping Records Between Batches')

      // ==== Step 9: Validate all records globally unique ====
      tracker.logTimestamp('Checking for duplicate records')
      const allRecords = mockServer.getCapturedTracyRecords()
      const allIds = allRecords.map((r) => r.recordId)
      const uniqueIds = new Set(allIds)
      console.log(`  Total records: ${allIds.length}, unique: ${uniqueIds.size}`)

      if (uniqueIds.size !== allIds.length) {
        // Find duplicates for debugging
        const seen = new Set<string>()
        const dupes: string[] = []
        for (const id of allIds) {
          if (seen.has(id)) dupes.push(id)
          seen.add(id)
        }
        console.log(`  DUPLICATES FOUND: ${dupes.map(id => id.slice(0, 8)).join(', ')}`)
      }

      expect(uniqueIds.size).toBe(allIds.length)
      tracker.mark('No Duplicate Records')

      // ==== Step 10: Validate record contents ====
      tracker.logTimestamp('Validating record contents')
      const s3Uploads = mockServer.getS3Uploads()
      console.log(`  S3 uploads: ${s3Uploads.size} objects`)

      for (const record of allRecords.slice(0, 3)) {
        expect(record.platform).toBe('CLAUDE_CODE')
        expect(record.recordId).toBeTruthy()
        expect(record.rawDataS3Key).toBeTruthy()

        // rawData is uploaded to S3 via presigned URL — retrieve from mock S3 store
        const s3Content = s3Uploads.get(record.rawDataS3Key!)
        expect(s3Content, `S3 upload not found for key: ${record.rawDataS3Key}`).toBeTruthy()

        const parsed = JSON.parse(s3Content!) as Record<string, unknown>
        console.log(`  Record ${record.recordId.slice(0, 8)}: type=${parsed.type}, keys=[${Object.keys(parsed).join(',')}]`)

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

      const totalDuration = Date.now() - testStart
      tracker.logTimestamp(`Test completed successfully (total: ${totalDuration}ms)`)
    },
    { timeout: TEST_TIMEOUT }
  )
})
