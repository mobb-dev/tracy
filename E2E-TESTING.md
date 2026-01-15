# E2E Testing Quick Start

This document provides a quick overview of the end-to-end testing setup for the Mobb AI Tracer extension across **Cursor, VS Code, and Claude Code**.

## ⚠️ Important: Production Bug Fixes Included

This PR includes **production bug fixes** discovered during E2E testing development:

- **VS Code Copilot Inference Capture Bug** - Fixed missing inference capture for `multi_replace_string_in_file` and `editFiles` tools that VS Code Copilot has been using since November 2025. See `__tests__/e2e/LESSONS.md` Challenge 23 for full details.
- **Fallback mechanism** - Added fallback to extract inferences from ChatMLSuccess when VS Code doesn't emit separate toolCall events.

**Impact:** These fixes prevent silent data loss for VS Code Copilot users.

## What Was Implemented

✅ **Complete E2E testing infrastructure** for 3 IDEs:
- **Cursor** - Full Playwright automation with Docker support
- **VS Code** - Full Playwright automation with Docker support
- **Claude Code** - TypeScript test runner (no UI automation needed)

Each test:
- Builds and packages the extension as VSIX
- Installs it in an isolated IDE instance
- Triggers AI code generation
- Validates that inferences are captured and uploaded correctly

## Quick Start

### Cursor E2E Tests

```bash
cd clients/tracer_ext

# Run locally (macOS)
npm run test:e2e:cursor:local

# Run in Docker (all platforms)
npm run test:e2e:cursor:full
```

Default shortcut: `npm run test:e2e` runs Cursor tests

### VS Code E2E Tests

```bash
cd clients/tracer_ext

# Run locally (macOS)
npm run test:e2e:vscode:local

# Run in Docker (all platforms)
npm run test:e2e:vscode:full
```

### Claude Code E2E Tests

```bash
cd clients/tracer_ext

# Run locally (requires Claude Code CLI installed)
npm run test:e2e:claude-code:local

# Run in Docker (all platforms)
npm run test:e2e:claude-code:full
```

## Available Commands

### Cursor

```bash
npm run test:e2e:cursor:local     # Build VSIX + run locally with Playwright
npm run test:e2e:cursor:full      # Build VSIX + Docker image + run tests
npm run test:e2e:cursor:full-vnc  # Same as full, with VNC enabled (port 25900)
npm run e2e:refresh-cursor-auth   # Export Cursor auth tokens
```

### VS Code

```bash
npm run test:e2e:vscode:local     # Build VSIX + run locally with Playwright
npm run test:e2e:vscode:full      # Build VSIX + Docker image + run tests
npm run test:e2e:vscode:full-vnc  # Same as full, with VNC enabled (port 15900)
npm run e2e:refresh-vscode-auth   # Export VS Code Copilot auth
```

### Claude Code

```bash
npm run test:e2e:claude-code:local  # Run locally with tsx
npm run test:e2e:claude-code:full   # Build Docker image + run tests
```

## What Gets Tested

### Cursor & VS Code (Playwright)

1. **Extension Installation** - VSIX is built and installed in test profile
2. **Extension Activation** - Extension starts and monitors database
3. **AI Agent Triggering** - Playwright simulates UI interactions (Cmd+L, prompts)
4. **Code Generation** - AI generates code changes
5. **Inference Capture** - Extension detects changes in SQLite database
6. **Upload Validation** - Mock server receives formatted inference data

### Claude Code (Direct Testing)

1. **Extension Installation** - Extension loaded in test workspace
2. **Extension Activation** - Verified through output logs
3. **AI Commands** - Direct command execution (no UI needed)
4. **Inference Capture** - Extension hooks into Claude Code's tool execution
5. **Upload Validation** - Mock server receives inference data

## Test Results

After running tests, find results in:

```bash
test-results/
├── *.png                    # Screenshots (captured throughout test)
├── *.webm                   # Videos (on failure)
├── results.json             # JSON test results
├── screenshot-viewer.html   # Interactive screenshot viewer
└── playwright-report/       # Playwright HTML report (if generated)
```

**View screenshots:**
```bash
open test-results/screenshot-viewer.html  # Auto-generated after tests
```

**View Playwright report:**
```bash
npx playwright show-report test-results/playwright-report
```

## CI/CD Integration

Tests automatically run on GitHub Actions:

- **Cursor**: `.github/workflows/cursor-e2e.yml`
- **VS Code**: `.github/workflows/vscode-e2e.yml`
- **Claude Code**: `.github/workflows/claude-code-e2e.yml`

**Triggers**: Push to main or PR affecting `clients/tracer_ext/**`

**Artifacts**: Test results, screenshots, videos automatically uploaded

## Architecture

### Cursor & VS Code (Playwright)

```
Docker Container (Isolated)
├── Xvfb (Virtual Display)
├── IDE (Cursor or VS Code) + Extension
├── Playwright (UI Automation)
│   ├── Opens IDE
│   ├── Triggers AI agent (Cmd+L or Copilot)
│   ├── Sends prompt
│   └── Accepts changes
├── SQLite Database (state.vscdb)
│   └── Extension monitors for inferences
└── Mock Upload Server (:3000)
    └── Captures GraphQL & S3 uploads
```

### Claude Code (TypeScript)

```
Node.js Process
├── Claude Code CLI + Extension
├── Test Script (tsx)
│   ├── Starts Claude Code
│   ├── Executes commands
│   └── Validates output
└── Mock Upload Server (:3000)
    └── Captures inference uploads
```

## Safety Guarantees

✅ **Local tests**: Isolated profiles in `/tmp/` (never touch your IDE)
✅ **Docker tests**: Complete containerization
✅ **Your data**: Never accessed
✅ **Cleanup**: Automatic after each test

## Authentication

### Cursor

Tests need Cursor authentication tokens to trigger AI features:

```bash
# Export your local Cursor auth (one-time)
npm run e2e:refresh-cursor-auth

# This creates __tests__/e2e/cursor/cursor-auth.b64 (git-ignored)
# In CI, this is stored as GitHub secret CURSOR_STATE_VSCDB_B64
```

### VS Code

VS Code Copilot authentication is handled automatically:

- **Local**: Uses GitHub Device Flow OAuth (opens browser)
- **CI**: Uses pre-built auth stored in GitHub secret `VSCODE_STATE_VSCDB_B64`

```bash
# Refresh VS Code auth (if needed)
npm run e2e:refresh-vscode-auth
```

### Claude Code

Requires Anthropic API key or AWS Bedrock credentials:

```bash
# Set environment variables
export ANTHROPIC_API_KEY=sk-ant-...

# Or for AWS Bedrock
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_DEFAULT_REGION=us-east-1
```

## Debugging

### Check Mock Server

```bash
# Run mock server standalone (for manual testing)
npx tsx __tests__/e2e/shared/mock-server.ts

# In another terminal, check health
curl http://localhost:3000/health

# View captured uploads
curl http://localhost:3000/debug/uploads

# View all requests
curl http://localhost:3000/debug/requests
```

### Enable VNC (Docker)

See running tests in real-time:

**Cursor:**
```bash
npm run test:e2e:cursor:full-vnc
# Connect VNC client to localhost:25900
```

**VS Code:**
```bash
npm run test:e2e:vscode:full-vnc
# Connect VNC client to localhost:15900
```

### View Test Output

```bash
# After test completes - generate HTML viewer for screenshots
npx tsx __tests__/e2e/generate-screenshot-viewer.ts
open test-results/screenshot-viewer.html
```

## Troubleshooting

### "Cursor/VS Code executable not found" (Local)

```bash
# macOS - Set executable path
export CURSOR_PATH=/Applications/Cursor.app/Contents/MacOS/Cursor
export VSCODE_PATH=/Applications/Visual\ Studio\ Code.app/Contents/MacOS/Electron

npm run test:e2e:cursor:local
npm run test:e2e:vscode:local
```

### "Extension not built"

```bash
npm run build
npm run package:test
ls -lh *.vsix  # Should show mobb-ai-tracer-*.vsix
```

### "Timeout waiting for uploads"

Check:
1. Extension activated? (check logs in test output)
2. AI agent responded? (check screenshots in `test-results/`)
3. Database being monitored? (check extension logs)
4. Mock server running? (`curl http://localhost:3000/health`)

### "Authentication failed" (Cursor)

```bash
# Re-export Cursor auth
npm run e2e:refresh-cursor-auth

# Verify file exists
ls -lh __tests__/e2e/cursor/cursor-auth.b64
```

## Documentation

**Detailed guides in `__tests__/e2e/`:**

- `README.md` - Comprehensive testing guide (289 lines)
- `LESSONS.md` - Lessons learned during development (1999 lines)
- `cursor/README.md` - Cursor-specific details
- `vscode/STATUS.md` - VS Code testing status
- `claude-code/README.md` - Claude Code testing details

## File Structure

```
clients/tracer_ext/
├── __tests__/e2e/
│   ├── config.env                     # Test configuration
│   ├── playwright.config.ts           # Playwright config
│   ├── cursor/
│   │   ├── playwright-automation.test.ts
│   │   ├── docker/Dockerfile
│   │   └── scripts/refresh-cursor-auth.sh
│   ├── vscode/
│   │   ├── playwright-automation.test.ts
│   │   ├── docker/Dockerfile
│   │   ├── helpers/device-flow-oauth.ts
│   │   └── scripts/refresh-vscode-auth.sh
│   ├── claude-code/
│   │   ├── claude-code-e2e.test.ts
│   │   └── docker/Dockerfile
│   ├── shared/
│   │   ├── mock-server.ts             # Express mock server
│   │   ├── assertions.ts              # Test helpers
│   │   └── test-workspace/            # Sample code
│   ├── README.md                      # Detailed docs
│   └── LESSONS.md                     # Development insights
├── package.json                       # E2E scripts
└── E2E-TESTING.md                     # This file
```

## Next Steps

1. **Try Cursor tests**:
   ```bash
   npm run test:e2e:cursor:local
   ```

2. **Try VS Code tests**:
   ```bash
   npm run test:e2e:vscode:local
   ```

3. **Try Claude Code tests**:
   ```bash
   npm run test:e2e:claude-code:local
   ```

4. **View results**:
   ```bash
   npx tsx __tests__/e2e/generate-screenshot-viewer.ts
   open test-results/screenshot-viewer.html
   ```

5. **Run in Docker** (recommended for CI):
   ```bash
   npm run test:e2e:cursor:full
   npm run test:e2e:vscode:full
   npm run test:e2e:claude-code:full
   ```

## Support

Questions? Check:
1. This guide
2. Detailed docs: `__tests__/e2e/README.md`
3. Lessons learned: `__tests__/e2e/LESSONS.md`
4. Test output and screenshots
5. GitHub Actions logs

---

**Ready to test!** 🚀

Run `npm run test:e2e` to get started with Cursor tests.
