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
const UPLOAD_WAIT_TIMEOUT = 30000 // 30 seconds for upload
const CLAUDE_CODE_TIMEOUT = 30000 // 30 seconds for Claude Code to respond
const TEST_TIMEOUT = 120000 // 120 seconds total test timeout

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

describe('Claude Code E2E with Hook Integration', () => {
  let _testStartTime: number
  let mockServer: MockUploadServer | null = null
  let claudeProcess: ChildProcess | null = null
  let testWorkspaceDir: string | null = null
  let claudeSettingsBackup: string | null = null

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
    tracker.logTimestamp('Cleanup')

    // Gracefully shut down Claude process if still running
    if (claudeProcess && !claudeProcess.killed) {
      try {
        // Try graceful shutdown first (SIGTERM)
        claudeProcess.kill('SIGTERM')

        // Wait up to 5 seconds for graceful shutdown
        const shutdownTimeout = setTimeout(() => {
          if (claudeProcess && !claudeProcess.killed) {
            console.log(
              '  ⚠️  Graceful shutdown timed out, forcing kill (SIGKILL)'
            )
            claudeProcess.kill('SIGKILL')
          }
        }, 5000)

        // Clear timeout if process exits cleanly
        claudeProcess.on('exit', () => clearTimeout(shutdownTimeout))
      } catch (err) {
        console.log(`  ⚠️  Error during process shutdown: ${err}`)
      }
    }

    // Kill daemon if running
    try {
      const pidData = JSON.parse(
        fs.readFileSync(
          path.join(os.homedir(), '.mobbdev', 'daemon.pid'),
          'utf8'
        )
      )
      process.kill(pidData.pid, 'SIGKILL')
    } catch {
      /* already dead or no pid file */
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
    tracker.printSummary()
  })

  it(
    'should capture and upload AI attribution via hook',
    async () => {
      // Kill any stale daemon from a previous test run
      try {
        const pidData = JSON.parse(
          fs.readFileSync(
            path.join(os.homedir(), '.mobbdev', 'daemon.pid'),
            'utf8'
          )
        )
        process.kill(pidData.pid, 'SIGKILL')
      } catch {
        /* no stale daemon */
      }

      _testStartTime = Date.now()
      tracker.logTimestamp('Test started')

      // ==== Step 1: Verify Claude Code is installed ====
      tracker.logTimestamp('Verifying Claude Code installation')
      try {
        const version = execSync('claude --version', { encoding: 'utf-8' })
        console.log(`  Claude Code version: ${version.trim()}`)
        tracker.mark('Claude Code Installed')
      } catch (error) {
        console.error('❌ Claude Code is not installed')
        console.error(
          '   Install with: npm install -g @anthropic-ai/claude-code'
        )
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

      // Create context files that the scanner should detect and upload
      // ── Rules ──────────────────────────────────────────────────────────────
      fs.writeFileSync(
        path.join(testWorkspaceDir, 'CLAUDE.md'),
        '# Project Rules\n\nAlways write clean code.\n'
      )
      fs.writeFileSync(
        path.join(testWorkspaceDir, 'CLAUDE.local.md'),
        '# Local Rules\n\nLocal machine overrides.\n'
      )
      fs.writeFileSync(
        path.join(testWorkspaceDir, 'AGENTS.md'),
        '# Agent Rules\n\nRules for AI agents.\n'
      )
      fs.writeFileSync(
        path.join(testWorkspaceDir, 'INSIGHTS.md'),
        '# Insights\n\nProject insights and learnings.\n'
      )
      fs.mkdirSync(path.join(testWorkspaceDir, '.claude', 'rules'), {
        recursive: true,
      })
      fs.writeFileSync(
        path.join(testWorkspaceDir, '.claude', 'rules', 'test-rule.md'),
        '# Test Rule\n\nAlways add JSDoc comments to exported functions.\n'
      )

      // ── Commands (.claude/commands/*.md → category:command, regular file) ──
      fs.mkdirSync(path.join(testWorkspaceDir, '.claude', 'commands'), {
        recursive: true,
      })
      fs.writeFileSync(
        path.join(testWorkspaceDir, '.claude', 'commands', 'my-command.md'),
        '---\ndescription: My custom command\n---\n\nRun this whenever needed.\n'
      )

      // ── Agent config (.claude/agents/*.md → category:agent-config) ─────────
      fs.mkdirSync(path.join(testWorkspaceDir, '.claude', 'agents'), {
        recursive: true,
      })
      fs.writeFileSync(
        path.join(testWorkspaceDir, '.claude', 'agents', 'my-agent.md'),
        '---\nname: My Agent\ndescription: A helpful coding agent\n---\n\nYou are a helpful coding agent.\n'
      )

      // ── Skill bundles (.claude/skills/ → category:skill, zipped) ───────────
      // Folder skill: directory with SKILL.md + sibling files → all zipped together
      fs.mkdirSync(
        path.join(testWorkspaceDir, '.claude', 'skills', 'folder-skill'),
        { recursive: true }
      )
      fs.writeFileSync(
        path.join(
          testWorkspaceDir,
          '.claude',
          'skills',
          'folder-skill',
          'SKILL.md'
        ),
        '---\nname: Folder Skill\ndescription: A skill that lives in a folder\n---\n\nProvides folder-based functionality.\n'
      )
      fs.writeFileSync(
        path.join(
          testWorkspaceDir,
          '.claude',
          'skills',
          'folder-skill',
          'helper.ts'
        ),
        '// Helper utilities\nexport function greet(name: string) {\n  return `Hello, ${name}!`\n}\n'
      )
      // Standalone skill: loose .md directly in skills/ → zipped as single file
      fs.writeFileSync(
        path.join(testWorkspaceDir, '.claude', 'skills', 'standalone-skill.md'),
        '---\nname: Standalone Skill\ndescription: A self-contained skill file\n---\n\nThis skill lives in a single file.\n'
      )

      // ── Config (.claude/settings.json → category:config) ───────────────────
      // Workspace-level settings (distinct from the hook settings written to ~/.claude/)
      fs.writeFileSync(
        path.join(testWorkspaceDir, '.claude', 'settings.json'),
        JSON.stringify({}, null, 2)
      )
      fs.writeFileSync(
        path.join(testWorkspaceDir, '.claude', 'settings.local.json'),
        JSON.stringify({}, null, 2)
      )

      // ── MCP config (.mcp.json → category:mcp-config) ───────────────────────
      fs.writeFileSync(
        path.join(testWorkspaceDir, '.mcp.json'),
        JSON.stringify({ mcpServers: {} }, null, 2)
      )
      fs.writeFileSync(
        path.join(testWorkspaceDir, '.claude', '.mcp.json'),
        JSON.stringify({ mcpServers: {} }, null, 2)
      )

      // ── Ignore (.claudeignore → category:ignore) ────────────────────────────
      fs.writeFileSync(
        path.join(testWorkspaceDir, '.claudeignore'),
        'node_modules/\n*.log\nbuild/\n'
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
              matcher: '',
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
        'Create a file called utils.ts with a function that adds two numbers'

      console.log(`  Prompt: "${prompt}"`)
      console.log(`  Working directory: ${testWorkspaceDir}`)

      // Run Claude Code in print mode (non-interactive)
      // --permission-mode bypassPermissions skips permission prompts for automated testing
      // --debug enables debug output which also fixes some initialization issues
      // Inherit all env vars including AWS_BEARER_TOKEN_BEDROCK, CLAUDE_CODE_USE_BEDROCK, etc.
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
            API_URL: 'http://localhost:3000/graphql',
            // Use local CLI build so the hook/shim spawns the daemon from source
            MOBBDEV_LOCAL_CLI: CLI_DIST,
            // Prevent nested-session rejection when running from within a Claude Code session
            CLAUDECODE: '',
          },
          // stdin: ignore (prevents hanging), stdout/stderr: inherit for visibility
          stdio: ['ignore', 'inherit', 'inherit'],
        }
      )

      tracker.mark('Claude Code Prompt Sent')

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

      expect(exitCode).toBe(0)

      // Check if code was generated
      const generatedFile = path.join(testWorkspaceDir, 'utils.ts')
      if (fs.existsSync(generatedFile)) {
        console.log('  ✅ File generated: utils.ts')
        const content = fs.readFileSync(generatedFile, 'utf-8')
        console.log(`  Content preview: ${content.substring(0, 100)}...`)
        tracker.mark('Code Generated')
      } else {
        console.log(
          '  ⚠️  utils.ts not found, checking other generated files...'
        )
        const files = fs.readdirSync(testWorkspaceDir)
        console.log(`  Files in workspace: ${files.join(', ')}`)
      }

      // ==== Step 7: Wait for hook to capture and upload raw tracy records ====
      tracker.logTimestamp('Waiting for tracy record upload')
      console.log(`  Timeout: ${UPLOAD_WAIT_TIMEOUT / 1000}s`)

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

      const record = records[0]
      console.log(`  Platform: ${record.platform}`)
      console.log(`  Record ID: ${record.recordId}`)
      console.log(`  Client version: ${record.clientVersion}`)

      // Validate TracyRecordInput fields
      expect(record.platform).toBe('CLAUDE_CODE')
      expect(record.recordId).toBeTruthy()
      expect(record.clientVersion).toBeTruthy()
      expect(record.rawDataS3Key).toBeTruthy()

      // rawData is uploaded to S3 via presigned URL — retrieve from mock S3 store
      const s3Uploads = mockServer.getS3Uploads()
      const s3Content = s3Uploads.get(record.rawDataS3Key!)
      expect(
        s3Content,
        `S3 upload not found for key: ${record.rawDataS3Key}`
      ).toBeTruthy()

      // Parse the content stored at the S3 key
      const parsedRawData = JSON.parse(s3Content!)
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

      // Each context file gets its own Tracy record:
      //   recordId = "ctx:{sessionId}:{md5}", with a `context` metadata field.
      // Skills are zipped (rawDataS3Key ends in .zip);
      // all other categories are plain text (ends in .bin).
      type ExpectedCtx = {
        label: string
        match: (r: (typeof allCtxRecords)[0]) => boolean
        category: string
        /** Plain-text content to verify in S3 (omit for zip uploads) */
        expectedContent?: string
      }

      const expectedCtxFiles: ExpectedCtx[] = [
        // ── Rules ────────────────────────────────────────────────────────────
        {
          label: 'CLAUDE.md',
          match: (r) => r.context?.name === 'CLAUDE.md',
          category: 'rule',
          expectedContent: '# Project Rules\n\nAlways write clean code.\n',
        },
        {
          label: 'CLAUDE.local.md',
          match: (r) => r.context?.name === 'CLAUDE.local.md',
          category: 'rule',
          expectedContent: '# Local Rules\n\nLocal machine overrides.\n',
        },
        {
          label: 'AGENTS.md',
          match: (r) => r.context?.name === 'AGENTS.md',
          category: 'rule',
          expectedContent: '# Agent Rules\n\nRules for AI agents.\n',
        },
        {
          label: 'INSIGHTS.md',
          match: (r) => r.context?.name === 'INSIGHTS.md',
          category: 'rule',
          expectedContent: '# Insights\n\nProject insights and learnings.\n',
        },
        {
          label: '.claude/rules/test-rule.md',
          match: (r) =>
            r.context?.name === '.claude/rules/test-rule.md',
          category: 'rule',
          expectedContent:
            '# Test Rule\n\nAlways add JSDoc comments to exported functions.\n',
        },
        // ── Commands (T-491: regular file, NOT a skill) ──────────────────────
        {
          label: '.claude/commands/my-command.md',
          match: (r) =>
            r.context?.name === '.claude/commands/my-command.md' &&
            r.context?.category === 'command',
          category: 'command',
          expectedContent:
            '---\ndescription: My custom command\n---\n\nRun this whenever needed.\n',
        },
        // ── Skill bundles (zipped) ────────────────────────────────────────────
        {
          label: '.claude/skills/folder-skill (folder bundle)',
          match: (r) =>
            r.context?.name === 'folder-skill' &&
            r.context?.category === 'skill',
          category: 'skill',
        },
        {
          label: '.claude/skills/standalone-skill.md (standalone)',
          match: (r) =>
            r.context?.name === 'standalone-skill' &&
            r.context?.category === 'skill',
          category: 'skill',
        },
        // ── Agent (treated as skill, zipped) ─────────────────────────────────
        {
          label: '.claude/agents/my-agent.md',
          match: (r) =>
            r.context?.name === 'my-agent' && r.context?.category === 'skill',
          category: 'skill',
        },
        // ── Config ────────────────────────────────────────────────────────────
        {
          label: '.claude/settings.json (workspace)',
          match: (r) => r.context?.name === '.claude/settings.json',
          category: 'config',
        },
        {
          label: '.claude/settings.local.json',
          match: (r) => r.context?.name === '.claude/settings.local.json',
          category: 'config',
        },
        // ── MCP config ────────────────────────────────────────────────────────
        {
          label: '.mcp.json',
          match: (r) => r.context?.name === '.mcp.json',
          category: 'mcp-config',
        },
        {
          label: '.claude/.mcp.json',
          match: (r) => r.context?.name === '.claude/.mcp.json',
          category: 'mcp-config',
        },
        // ── Ignore ────────────────────────────────────────────────────────────
        {
          label: '.claudeignore',
          match: (r) => r.context?.name === '.claudeignore',
          category: 'ignore',
          expectedContent: 'node_modules/\n*.log\nbuild/\n',
        },
      ]

      const ctxPollStart = Date.now()
      const foundCtx = new Map<string, (typeof allCtxRecords)[0]>()
      let allCtxRecords: ReturnType<typeof mockServer.getCapturedTracyRecords> =
        []

      while (Date.now() - ctxPollStart < UPLOAD_WAIT_TIMEOUT) {
        allCtxRecords = mockServer
          .getCapturedTracyRecords()
          .filter((r) => r.recordId?.startsWith('ctx:') && r.context)

        for (const exp of expectedCtxFiles) {
          if (!foundCtx.has(exp.label)) {
            const record = allCtxRecords.find(exp.match)
            if (record) foundCtx.set(exp.label, record)
          }
        }

        if (foundCtx.size === expectedCtxFiles.length) break
        await new Promise((r) => setTimeout(r, 1000))
      }

      console.log(`  Context file records: ${allCtxRecords.length} total`)
      for (const r of allCtxRecords) {
        console.log(
          `    - ${r.context?.name} (${r.context?.category}) → ${r.rawDataS3Key?.split('/').pop()}`
        )
      }

      for (const exp of expectedCtxFiles) {
        const record = foundCtx.get(exp.label)
        expect(record, `"${exp.label}" should appear in context records`).toBeTruthy()
        if (!record) continue

        expect(record.platform, `${exp.label}: platform`).toBe('CLAUDE_CODE')
        expect(
          record.recordId?.startsWith('ctx:'),
          `${exp.label}: recordId prefix`
        ).toBe(true)
        expect(record.context?.category, `${exp.label}: category`).toBe(
          exp.category
        )

        const s3Key = record.rawDataS3Key!
        expect(s3Key, `${exp.label}: rawDataS3Key`).toBeTruthy()

        if (exp.category === 'skill') {
          // Skills are zipped — key ends in .zip
          expect(s3Key, `${exp.label}: S3 key should end in .zip`).toMatch(
            /\.zip$/
          )
          const zipContent = s3Uploads.get(s3Key)
          expect(
            zipContent,
            `${exp.label}: zip should be uploaded to S3`
          ).toBeTruthy()
        } else {
          // All other categories are plain-text — key ends in .bin
          expect(s3Key, `${exp.label}: S3 key should end in .bin`).toMatch(
            /\.bin$/
          )
          if (exp.expectedContent !== undefined) {
            const s3Content = s3Uploads.get(s3Key)
            expect(s3Content, `${exp.label}: S3 content`).toBe(
              exp.expectedContent
            )
          }
        }
      }

      console.log('  ✅ Context files uploaded and validated')
      tracker.mark('Context Files Uploaded')

      // ==== Success ====
      tracker.logTimestamp('Test completed successfully')
    },
    { timeout: TEST_TIMEOUT }
  )
})
