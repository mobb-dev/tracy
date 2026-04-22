import { ChildProcess, execSync, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'


import { afterEach, describe, expect, it } from 'vitest'

import { initGitRepository } from '../shared/git-utils'
import { MockUploadServer } from '../shared/mock-server'
import {
  MOCK_API_URL_DEFAULT,
  MOCK_MOBB_API_URL_DEFAULT,
  MOCK_SERVER_DEFAULT_PORT,
} from '../shared/test-config'
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

// Test configuration
const CLI_DIST = path.resolve(__dirname, '../../../../cli/dist/index.mjs')
const UPLOAD_WAIT_TIMEOUT = 60000 // 60 seconds for upload (hooks use npx which is slow first run)
const CLAUDE_CODE_TIMEOUT = 90000 // 90 seconds for Claude Code to respond (Windows is slower)
const TEST_TIMEOUT = 180000 // 3 minutes total test timeout

// Only run on Windows — skipped automatically on Linux containers
describe.skipIf(process.platform !== 'win32')('Claude Code E2E with Hook Integration (Windows)', () => {
  let testStartTime: number
  let mockServer: MockUploadServer | null = null
  let claudeProcess: ChildProcess | null = null
  let testWorkspaceDir: string | null = null
  let claudeSettingsBackup: string | null = null
  // True when the test wrote a settings.json where none existed before — so
  // cleanup knows to delete (not just overwrite) the file we created.
  let claudeSettingsCreated = false

  // Abnormal-exit cleanup: if the test host receives SIGINT/SIGTERM or the
  // process crashes before `afterEach` runs, we still need to restore (or
  // delete) the global Claude settings — otherwise we leak test config onto
  // the developer's real home directory.
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
    'Context Files Uploaded',
  ])

  afterEach(async () => {
    // Cleanup
    tracker.logTimestamp('Cleanup started')

    // Log final mock server state before shutting down
    if (mockServer) {
      const records = mockServer.getCapturedTracyRecords()
      const s3 = mockServer.getS3Uploads()
      console.log(`  [cleanup] Mock server final state: ${records.length} tracy records, ${s3.size} S3 uploads`)
    }

    // Kill Claude process tree (taskkill on Windows, SIGKILL on Unix)
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

    // Stop mock server
    if (mockServer) {
      console.log('  [cleanup] Stopping mock server')
      await mockServer.stop()
    }

    // Restore (or delete) Claude settings — we must not leave a test-written
    // settings.json behind when the host had no pre-existing file.
    if (claudeSettingsBackup !== null) {
      console.log(`  [cleanup] Restoring Claude settings at ${claudeSettingsPath}`)
      fs.writeFileSync(claudeSettingsPath, claudeSettingsBackup)
    } else if (claudeSettingsCreated && fs.existsSync(claudeSettingsPath)) {
      console.log(`  [cleanup] Deleting test-created Claude settings at ${claudeSettingsPath}`)
      fs.unlinkSync(claudeSettingsPath)
    }
    claudeSettingsCreated = false
    claudeSettingsBackup = null

    // Cleanup test workspace
    if (testWorkspaceDir && fs.existsSync(testWorkspaceDir)) {
      console.log(`  [cleanup] Removing workspace: ${testWorkspaceDir}`)
      try {
        fs.rmSync(testWorkspaceDir, { recursive: true, force: true })
      } catch (cleanupError) {
        console.log('  [cleanup] Could not cleanup workspace:', cleanupError)
      }
    }

    tracker.logTimestamp('Cleanup complete')
    tracker.printSummary()
  })

  it(
    'should capture and upload AI attribution via hook',
    async () => {
      // Kill any stale daemon from a previous test run
      try {
        const pidData = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.mobbdev', 'daemon.pid'), 'utf8'))
        console.log(`  [pre-test] Killing stale daemon (pid: ${pidData.pid})`)
        killProcessTree(pidData.pid)
      } catch { /* no stale daemon */ }

      testStartTime = Date.now()
      tracker.logTimestamp('Test started')

      // ==== Step 0: Log Windows environment ====
      console.log('')
      console.log('  =============================================')
      console.log('  WINDOWS E2E TEST — SINGLE TURN')
      console.log('  =============================================')
      logWindowsEnvironment({ CLI_DIST, 'CLI_DIST exists': String(fs.existsSync(CLI_DIST)) })
      logRelevantEnvVars(['PATH'])
      console.log('')

      // ==== Step 1: Verify Claude Code is installed ====
      tracker.logTimestamp('Verifying Claude Code installation')
      try {
        const version = execSync('claude --version', { encoding: 'utf-8' })
        console.log(`  Claude Code version: ${version.trim()}`)

        // Log claude binary location
        try {
          const whereClaude = execSync('where claude', { encoding: 'utf-8' })
          console.log(`  Claude binary: ${whereClaude.trim()}`)
        } catch { /* where not available */ }

        tracker.mark('Claude Code Installed')
      } catch (error) {
        console.error('  FATAL: Claude Code is not installed')
        console.error('  Install with: npm install -g @anthropic-ai/claude-code')
        console.error(`  Error: ${error}`)

        // Log PATH for debugging
        console.error(`  PATH entries:`)
        const pathEntries = (process.env.PATH || '').split(path.delimiter)
        for (const p of pathEntries) {
          console.error(`    - ${p}`)
        }

        throw new Error('Claude Code not found')
      }

      // Verify mobbdev is available
      try {
        const mobbdevVersion = execSync('mobbdev --version', { encoding: 'utf-8' })
        console.log(`  Mobbdev CLI version: ${mobbdevVersion.trim()}`)
      } catch {
        console.log('  WARNING: mobbdev CLI not found in PATH')
      }

      // ==== Step 2: Verify AWS Bedrock configuration ====
      tracker.logTimestamp('Checking AWS Bedrock configuration')
      const hasAwsCredentials =
        process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      const hasBedrockToken = process.env.AWS_BEARER_TOKEN_BEDROCK
      const hasAnthropicKey = process.env.ANTHROPIC_API_KEY

      if (hasBedrockToken) {
        console.log('  Auth method: AWS Bedrock bearer token')
        console.log(`  Region: ${process.env.AWS_REGION || 'us-west-2'}`)
        tracker.mark('AWS Bedrock Configured')
      } else if (hasAwsCredentials) {
        console.log('  Auth method: AWS Bedrock IAM credentials')
        console.log(`  Region: ${process.env.AWS_DEFAULT_REGION || 'us-west-2'}`)
        console.log(`  Key ID suffix: ***${process.env.AWS_ACCESS_KEY_ID!.slice(-4)}`)
        tracker.mark('AWS Bedrock Configured')
      } else if (hasAnthropicKey) {
        console.log('  Auth method: Anthropic API key (fallback)')
        tracker.mark('AWS Bedrock Configured')
      } else {
        console.error('  FATAL: No API credentials found')
        console.error('  Available env vars:')
        for (const key of Object.keys(process.env).sort()) {
          if (key.match(/aws|anthropic|bedrock|claude/i)) {
            console.error(`    ${key}=${key.match(/key|secret|token/i) ? '***' : process.env[key]}`)
          }
        }
        throw new Error('API credentials are required to run E2E tests')
      }

      // ==== Step 3: Start mock server ====
      tracker.logTimestamp('Starting mock server')

      // Fail fast if the port is already bound — a silent collision would
      // make the rest of the test mysteriously time out on upload.
      await assertPortFree(MOCK_SERVER_DEFAULT_PORT)

      mockServer = new MockUploadServer(MOCK_SERVER_DEFAULT_PORT)
      await mockServer.start()
      console.log(`  Mock server started on port ${MOCK_SERVER_DEFAULT_PORT}`)
      console.log('  Mock server health check:')

      // Quick health check
      try {
        const http = await import('node:http')
        await new Promise<void>((resolve) => {
          http.get(`${MOCK_MOBB_API_URL_DEFAULT}/health`, (res) => {
            console.log(`    Status: ${res.statusCode}`)
            resolve()
          }).on('error', (err) => {
            console.log(`    Health check failed: ${err.message}`)
            resolve()
          })
        })
      } catch (err) {
        console.log(`    Health check error: ${err}`)
      }

      tracker.mark('Mock Server Running')

      // ==== Step 4: Create test workspace ====
      tracker.logTimestamp('Creating test workspace')
      testWorkspaceDir = path.join(getWindowsTempBase(), `claude-code-e2e-win-${Date.now()}`)
      console.log(`  Target path: ${testWorkspaceDir}`)
      fs.mkdirSync(testWorkspaceDir, { recursive: true })

      // Create initial file before git init
      const indexPath = path.join(testWorkspaceDir, 'index.js')
      fs.writeFileSync(indexPath, '// Test file\nconsole.log("Hello");\n')
      console.log(`  Created: ${indexPath} (${fs.statSync(indexPath).size} bytes)`)

      // Create context files that the scanner should detect and upload
      fs.writeFileSync(
        path.join(testWorkspaceDir, 'CLAUDE.md'),
        '# Project Rules\n\nAlways write clean code.\n'
      )
      fs.mkdirSync(path.join(testWorkspaceDir, '.claude', 'rules'), {
        recursive: true,
      })
      fs.writeFileSync(
        path.join(testWorkspaceDir, '.claude', 'rules', 'test-rule.md'),
        '# Test Rule\n\nAlways add JSDoc comments to exported functions.\n'
      )
      console.log('  Created context files: CLAUDE.md, .claude/rules/test-rule.md')

      // Initialize git repo (required for Claude Code)
      console.log('  Initializing git repository...')
      await initGitRepository(testWorkspaceDir, {
        commitMessage: 'Initial commit',
      })

      // Verify git init worked
      const gitDir = path.join(testWorkspaceDir, '.git')
      console.log(`  Git dir exists: ${fs.existsSync(gitDir)}`)
      logDirectoryContents(testWorkspaceDir, '  Workspace contents')

      // ==== Step 5: Install Mobb hook in Claude Code settings ====
      tracker.logTimestamp('Installing Mobb hook')
      console.log(`  Settings path: ${claudeSettingsPath}`)

      // Ensure .claude directory exists
      fs.mkdirSync(path.dirname(claudeSettingsPath), { recursive: true })

      // Backup existing settings if any
      if (fs.existsSync(claudeSettingsPath)) {
        claudeSettingsBackup = fs.readFileSync(claudeSettingsPath, 'utf-8')
        console.log(`  Backed up existing settings (${claudeSettingsBackup.length} bytes)`)
      } else {
        console.log('  No existing settings to back up')
      }

      // Create settings with both a debug hook (dumps event params to file)
      // and the Mobb hook. The debug hook runs first and writes the full
      // hook environment and stdin to a file for CI diagnostics.
      const hookCommand = 'npx mobbdev claude-code-process-hook'
      const hookDebugFile = path.join(testWorkspaceDir, 'hook-debug.log')
      // Debug hook: reads the target path from $HOOK_DEBUG_FILE rather than
      // inlining it into the JS string. String interpolation on Windows paths
      // is a footgun (backslashes + quotes need escaping twice and a path
      // containing `'` breaks out of the node -e argument).
      const debugHookCommand = `node -e "const fs=require('fs');const p=process.env.HOOK_DEBUG_FILE;let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const log='--- HOOK FIRED: '+new Date().toISOString()+'\\n'+'ENV KEYS: '+Object.keys(process.env).filter(k=>k.match(/claude|mobb|api|aws/i)).join(', ')+'\\n'+'STDIN: '+d+'\\n\\n';fs.appendFileSync(p,log)})"`
      const settings: ClaudeCodeSettings = {
        hooks: {
          PostToolUse: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: debugHookCommand,
                },
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
      claudeSettingsCreated = claudeSettingsBackup === null
      console.log(`  Hook command: ${hookCommand}`)
      console.log(`  Debug hook file: ${hookDebugFile}`)
      console.log(`  Settings written: ${JSON.stringify(settings, null, 2)}`)
      tracker.mark('Mobb Hook Installed')

      // ==== Step 6: Run Claude Code with a prompt ====
      tracker.logTimestamp('Running Claude Code')

      const prompt =
        'Create a file called utils.js with a function that adds two numbers'

      console.log(`  Prompt: "${prompt}"`)
      console.log(`  Working directory: ${testWorkspaceDir}`)
      console.log(`  MOBBDEV_LOCAL_CLI: ${CLI_DIST}`)
      console.log(`  API_URL: ${MOCK_API_URL_DEFAULT}`)

      // On Windows, `claude` is installed as claude.cmd which spawn() can't
      // resolve directly. Using shell: true mangles args (splits the prompt).
      // Instead, invoke cmd.exe explicitly — Node.js passes each arg correctly
      // to CreateProcess, and cmd.exe resolves claude.cmd via PATHEXT.
      //
      // --dangerously-skip-permissions: bypasses all tool permission checks
      // --output-format json: captures full response with tool calls for debugging
      const claudeArgs = [
        '--print',
        '--dangerously-skip-permissions',
        '--output-format', 'json',
        '--verbose',
        prompt,
      ]
      console.log(`  Spawn: cmd.exe /c claude ${claudeArgs.map(a => a.length > 50 ? a.slice(0, 50) + '...' : a).join(' ')}`)

      claudeProcess = spawn(
        'cmd.exe',
        ['/c', 'claude', ...claudeArgs],
        {
          cwd: testWorkspaceDir,
          env: {
            ...process.env,
            API_URL: MOCK_API_URL_DEFAULT,
            MOBBDEV_LOCAL_CLI: CLI_DIST,
            // Read by the debug hook — avoids interpolating a Windows path
            // with backslashes into the `node -e` string.
            HOOK_DEBUG_FILE: hookDebugFile,
          },
          stdio: ['ignore', 'inherit', 'inherit'],
        }
      )

      console.log(`  Claude process PID: ${claudeProcess.pid}`)
      tracker.mark('Claude Code Prompt Sent')

      // Wait for Claude Code to complete
      const exitCode = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => {
          console.log(`  TIMEOUT: Claude Code did not exit within ${CLAUDE_CODE_TIMEOUT}ms`)
          // SIGKILL only kills the top-level cmd.exe on Windows; child claude
          // + hook + daemon keep running. killProcessTree uses taskkill /T.
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

      // Log workspace state after Claude Code ran
      logDirectoryContents(testWorkspaceDir, '  Workspace after Claude Code')

      // Dump debug hook log if it exists
      if (fs.existsSync(hookDebugFile)) {
        const hookLog = fs.readFileSync(hookDebugFile, 'utf-8')
        console.log(`  ┌─ HOOK DEBUG LOG (${hookLog.length} bytes) ────`)
        console.log(hookLog)
        console.log(`  └──────────────────────────────────`)
      } else {
        console.log('  HOOK DEBUG LOG: file not found — hooks did NOT fire')
      }

      expect(exitCode).toBe(0)

      // Check if code was generated
      const generatedFile = path.join(testWorkspaceDir, 'utils.js')
      if (fs.existsSync(generatedFile)) {
        const content = fs.readFileSync(generatedFile, 'utf-8')
        console.log(`  File generated: utils.js (${content.length} bytes)`)
        console.log(`  Content:\n${content}`)
        tracker.mark('Code Generated')
      } else {
        console.log('  utils.js NOT found — listing workspace:')
        const files = fs.readdirSync(testWorkspaceDir)
        for (const f of files) {
          const stat = fs.statSync(path.join(testWorkspaceDir, f))
          console.log(`    ${f} (${stat.isDirectory() ? 'DIR' : `${stat.size}B`})`)
        }
      }

      // ==== Step 7: Wait for hook to capture and upload raw tracy records ====
      tracker.logTimestamp('Waiting for tracy record upload')
      console.log(`  Timeout: ${UPLOAD_WAIT_TIMEOUT / 1000}s`)
      console.log(`  Current mock server state: ${mockServer.getCapturedTracyRecords().length} records`)

      await mockServer.waitForTracyRecords(1, {
        timeout: UPLOAD_WAIT_TIMEOUT,
        logInterval: 5000,
      })
      tracker.mark('Hook Captured Attribution')

      // ==== Step 8: Validate tracy record upload ====
      tracker.logTimestamp('Validating tracy record upload')
      const records = mockServer.getCapturedTracyRecords()

      expect(records.length).toBeGreaterThan(0)

      console.log(`  Tracy records received: ${records.length}`)

      // Log ALL records for debugging
      for (let i = 0; i < records.length; i++) {
        const r = records[i]
        console.log(`  ┌─ Record #${i + 1} ────────────────────`)
        console.log(`  │ Platform:       ${r.platform}`)
        console.log(`  │ Record ID:      ${r.recordId}`)
        console.log(`  │ Timestamp:      ${r.recordTimestamp}`)
        console.log(`  │ Client Version: ${r.clientVersion}`)
        console.log(`  │ Repository URL: ${r.repositoryUrl}`)
        console.log(`  │ Computer Name:  ${r.computerName}`)
        console.log(`  │ User Name:      ${r.userName}`)
        console.log(`  │ Raw Data S3Key: ${r.rawDataS3Key}`)
        console.log(`  │ Edit Type:      ${r.editType}`)
        console.log(`  │ File Path:      ${r.filePath}`)
        console.log(`  └──────────────────────────────────`)
      }

      // Find a CLAUDE_CODE record that isn't the context-files bundle (which
      // appears with recordId prefix `ctx:` and has no per-event attribution).
      // records[0] was unsafe because ordering depends on upload timing —
      // a context-files bundle arriving first would make assertions fail.
      const record = records.find(
        (r) => r.platform === 'CLAUDE_CODE' && !r.recordId.startsWith('ctx:')
      )
      expect(
        record,
        `No CLAUDE_CODE attribution record in ${records.length} uploads`
      ).toBeTruthy()

      // Validate TracyRecordInput fields
      expect(record!.recordId).toBeTruthy()
      expect(record!.clientVersion).toBeTruthy()
      expect(record!.rawDataS3Key).toBeTruthy()

      // rawData is uploaded to S3 via presigned URL — retrieve from mock S3 store
      const s3Uploads = mockServer.getS3Uploads()
      console.log(`  S3 uploads: ${s3Uploads.size} objects`)
      for (const [key, value] of s3Uploads.entries()) {
        console.log(`    Key: ${key} (${value.length} bytes)`)
      }

      const s3Content = s3Uploads.get(record!.rawDataS3Key!)
      expect(s3Content, `S3 upload not found for key: ${record!.rawDataS3Key}`).toBeTruthy()

      // Parse the content stored at the S3 key
      const parsedRawData = JSON.parse(s3Content!)
      console.log(`  Raw data type: ${parsedRawData.type}`)
      console.log(`  Raw data keys: ${Object.keys(parsedRawData).join(', ')}`)

      expect(parsedRawData.type).toBeTruthy()
      expect([
        'user',
        'assistant',
        'system',
        'summary',
        'progress',
        'attachment',
      ]).toContain(parsedRawData.type)

      tracker.mark('Attribution Uploaded')

      // ==== Step 9: Validate context file upload ====
      tracker.logTimestamp('Validating context file upload')

      // Since T-476, each context file is uploaded individually to S3 with its
      // own Tracy record (recordId = "ctx:{sessionId}:{md5}") and a `context`
      // metadata field. Poll until both expected files appear.
      const contextFileTimeout = UPLOAD_WAIT_TIMEOUT
      const pollStart = Date.now()
      let allContextRecords: ReturnType<
        typeof mockServer.getCapturedTracyRecords
      > = []
      let claudeMdRecord: (typeof allContextRecords)[0] | undefined
      let testRuleRecord: (typeof allContextRecords)[0] | undefined
      while (Date.now() - pollStart < contextFileTimeout) {
        allContextRecords = mockServer
          .getCapturedTracyRecords()
          .filter((r) => r.recordId?.startsWith('ctx:') && r.context)
        claudeMdRecord = allContextRecords.find(
          (r) => r.context?.name === 'CLAUDE.md'
        )
        testRuleRecord = allContextRecords.find((r) =>
          r.context?.filePath?.includes('.claude/rules/test-rule.md')
        )
        if (claudeMdRecord && testRuleRecord) {
          break
        }
        await new Promise((r) => setTimeout(r, 1000))
      }

      console.log(`  Context file records: ${allContextRecords.length} files`)
      for (const r of allContextRecords) {
        console.log(`    - ${r.context?.name} (${r.context?.category})`)
      }

      // Verify workspace CLAUDE.md was captured
      expect(
        claudeMdRecord,
        'CLAUDE.md should be in context records'
      ).toBeTruthy()
      expect(claudeMdRecord!.context?.category).toBe('rule')
      expect(claudeMdRecord!.platform).toBe('CLAUDE_CODE')
      const s3ForClaude = mockServer
        .getS3Uploads()
        .get(claudeMdRecord!.rawDataS3Key!)
      const expectedClaudeMd = '# Project Rules\n\nAlways write clean code.\n'
      expect(s3ForClaude).toBe(expectedClaudeMd)

      // Verify .claude/rules/test-rule.md was captured
      expect(
        testRuleRecord,
        '.claude/rules/test-rule.md should be in context records'
      ).toBeTruthy()
      expect(testRuleRecord!.context?.category).toBe('rule')
      const s3ForTestRule = mockServer
        .getS3Uploads()
        .get(testRuleRecord!.rawDataS3Key!)
      const expectedTestRule =
        '# Test Rule\n\nAlways add JSDoc comments to exported functions.\n'
      expect(s3ForTestRule).toBe(expectedTestRule)

      console.log('  Context files uploaded and validated')
      tracker.mark('Context Files Uploaded')

      // ==== Success ====
      const totalDuration = Date.now() - testStartTime
      tracker.logTimestamp(`Test completed successfully (total: ${totalDuration}ms)`)
    },
    { timeout: TEST_TIMEOUT }
  )
})
