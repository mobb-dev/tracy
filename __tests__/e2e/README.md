# Extension E2E Tests

End-to-end tests for the Mobb AI Tracer extension using Playwright.

Supports both **Cursor** and **VS Code + Copilot**.

## What It Tests

1. Launches IDE (Cursor or VS Code) with the extension installed
2. Triggers AI agent (Cursor Agent or GitHub Copilot) to generate code
3. Validates that the extension captures and uploads AI inference data

---

## ⚠️ IMPORTANT: VS Code E2E Testing Status

**❌ VS Code E2E UI testing in headless Docker is NOT VIABLE**

After exhaustive investigation (January 10, 2026), we determined that **VS Code cannot run in headless Docker environments** due to fundamental Electron renderer process GPU initialization failures.

**Investigation Summary**:
- **Tools tested**: Playwright (2 attempts), Spectron, WebdriverIO (2 attempts)
- **Configurations tested**: 5 different setups including advanced GPU flags
- **Result**: All failed with same root cause - renderer process crashes
- **Duration**: ~6 hours of systematic investigation

**Root Cause**:
```
ERROR:components/viz/service/main/viz_main_impl.cc:189
Exiting GPU process due to errors during initialization
Renderer process killed (reason: killed, code: 9)
```

**Alternatives**:
1. ✅ **Use Cursor E2E tests** (working) - Validates extension core functionality
2. Use `@vscode/test-electron` for API-level tests (no UI automation)
3. Use VNC-enabled Docker (not truly headless)

**Documentation**:
- Complete findings: `vscode-tmp/INVESTIGATION_COMPLETE.md`
- CI workflow disabled: `.github/workflows/vscode-e2e.yml.disabled`

**Recommendation**: Focus on Cursor E2E tests for CI validation. VS Code support can be added if/when running in non-headless environment.

---

## Directory Structure

```
__tests__/e2e/
├── shared/                     # Shared utilities
│   ├── mock-server.ts          # Mock server that captures uploads
│   ├── mock-servers.ts         # Multi-port mock server orchestrator
│   ├── assertions.ts           # Test assertion helpers
│   └── test-workspace/         # Sample workspace for AI to modify
├── cursor/                     # Cursor-specific tests
│   ├── playwright-automation.test.ts
│   ├── cursor-login-helper.ts
│   ├── cursor-auth.b64         # Auth tokens (gitignored)
│   ├── scripts/refresh-cursor-auth.sh
│   └── docker/Dockerfile
├── vscode/                     # VS Code + Copilot tests
│   ├── playwright-automation.test.ts
│   ├── vscode-helper.ts
│   ├── vscode-auth.b64         # Auth tokens (gitignored)
│   ├── scripts/refresh-vscode-auth.sh
│   └── docker/Dockerfile
├── LESSONS.md                  # Technical learnings
└── README.md                   # This file
```

## Quick Start

### Cursor Tests

```bash
cd clients/tracer_ext

# Local testing (macOS)
npm run test:e2e:cursor:local

# Docker testing (CI-like)
npm run test:e2e:cursor:full

# With authentication (full inference test)
npm run e2e:refresh-cursor-auth   # Export Cursor login
npm run test:e2e:cursor:full
```

### VS Code + Copilot Tests

```bash
cd clients/tracer_ext

# Local testing (macOS)
npm run test:e2e:vscode:local

# Docker testing (CI-like)
npm run test:e2e:vscode:full

# With authentication (full inference test)
npm run e2e:refresh-vscode-auth   # Export VS Code login
npm run test:e2e:vscode:full
```

## CI (GitHub Actions)

Tests run automatically via:
- ✅ `.github/workflows/cursor-e2e.yml` - **Cursor tests (ACTIVE)**
- ❌ `.github/workflows/vscode-e2e.yml.disabled` - **VS Code tests (DISABLED - not viable in headless Docker)**

Triggered on:
- Push to `main` with changes to `clients/tracer_ext/**`
- Pull requests to `main`
- Manual trigger via workflow_dispatch

**Note**: Only Cursor E2E tests run in CI. VS Code E2E workflow is disabled due to fundamental incompatibility with headless environments (see status section above).

## Authentication

Tests can run in two modes:

### 1. Infrastructure-Only Mode (No Auth)

Without authentication, the test validates:
- Extension installs correctly
- Extension activates and makes GraphQL requests
- Mock server receives API calls

### 2. Full Test Mode (With Auth)

With authentication, the test also validates:
- AI generation actually works
- Extension captures inference data
- Upload to mock S3 endpoint succeeds

#### Setting Up Cursor Auth

```bash
# Make sure you're logged into Cursor IDE
npm run e2e:refresh-cursor-auth

# Creates __tests__/e2e/cursor/cursor-auth.b64 (gitignored)
```

For CI: Add contents as GitHub secret `CURSOR_STATE_VSCDB_B64`

#### Setting Up VS Code Auth

```bash
# Make sure you're logged into VS Code with GitHub (Copilot)
npm run e2e:refresh-vscode-auth

# Creates __tests__/e2e/vscode/vscode-auth.b64 (gitignored)
```

For CI: Add contents as GitHub secret `VSCODE_STATE_VSCDB_B64`

## Environment Variables

### Cursor Tests

| Variable | Description | Default |
|----------|-------------|---------|
| `CURSOR_PATH` | Path to Cursor executable | Auto-detected |
| `CURSOR_AUTH_DIR` | Directory with auth files | None |
| `CURSOR_STATE_VSCDB_B64` | Base64-encoded auth database | None |

### VS Code Tests

| Variable | Description | Default |
|----------|-------------|---------|
| `VSCODE_PATH` | Path to VS Code executable | Auto-detected |
| `VSCODE_AUTH_DIR` | Directory with auth files | None |
| `VSCODE_STATE_VSCDB_B64` | Base64-encoded auth database | None |

### Common

| Variable | Description | Default |
|----------|-------------|---------|
| `TEST_TEMP_DIR` | Temp directory for test profile | System temp |
| `CI` | Set to `true` in CI environments | `false` |
| `ENABLE_VNC` | Enable VNC server in Docker | `false` |
| `DEBUG` | Enable debug logging | `false` |

## npm Scripts

### Cursor

| Script | Description |
|--------|-------------|
| `test:e2e:cursor:local` | Run Cursor test locally |
| `test:e2e:cursor:full` | Build Docker image and run test |
| `test:e2e:cursor:build-image` | Build Cursor Docker image |
| `test:e2e:cursor:run-docker` | Run test in Docker |
| `test:e2e:cursor:run-docker-vnc` | Run with VNC enabled |
| `e2e:refresh-cursor-auth` | Export Cursor auth tokens |

### VS Code

| Script | Description |
|--------|-------------|
| `test:e2e:vscode:local` | Run VS Code test locally |
| `test:e2e:vscode:full` | Build Docker image and run test |
| `test:e2e:vscode:build-image` | Build VS Code Docker image |
| `test:e2e:vscode:run-docker` | Run test in Docker |
| `e2e:refresh-vscode-auth` | Export VS Code auth tokens |

### Common

| Script | Description |
|--------|-------------|
| `mock-server` | Start mock server standalone |
| `generate-screenshot-viewer` | Generate HTML viewer for screenshots |

## Test Results

After running, check `test-results/` for:

- `*.png` - Screenshots at each test step
- `log-*.log` - Extension and VS Code/Cursor logs
- `docker-run.log` - Full Docker output (in CI artifacts)
- `screenshot-viewer.html` - Visual test report

## Debugging

### View Screenshots

```bash
# Generate HTML viewer
npm run generate-screenshot-viewer
# Opens test-results/screenshot-viewer.html
```

### Enable VNC in Docker

```bash
# Run with VNC for visual debugging (Cursor)
npm run test:e2e:cursor:run-docker-vnc

# Connect with VNC client to localhost:5900
```

### Check Extension Logs

```bash
# After test failure
cat test-results/log-4-mobb-ai-tracer.log
cat test-results/log-exthost.log
```

## Troubleshooting

### Test Passes Without Auth

If you see "infrastructure-only mode", auth wasn't detected:

```bash
# Verify auth file exists and has content
ls -la __tests__/e2e/cursor/cursor-auth.b64   # For Cursor
ls -la __tests__/e2e/vscode/vscode-auth.b64   # For VS Code

# Re-export if needed
npm run e2e:refresh-cursor-auth   # Cursor
npm run e2e:refresh-vscode-auth   # VS Code
```

### Port Already Allocated

```bash
# Kill processes using test ports
lsof -ti:8080,5173,3000 | xargs kill -9
```

### Docker Image Out of Date

```bash
# Force rebuild
npm run test:e2e:cursor:build-image
npm run test:e2e:vscode:build-image
```

## Missing Test Scenarios

The following test scenarios are not currently covered by E2E tests and should be considered for future implementation:

### Error Handling and Edge Cases
- ❌ **Network failures during upload** - Test behavior when API calls fail or timeout
- ❌ **Invalid authentication tokens** - Verify graceful handling of expired/invalid credentials
- ❌ **Malformed AI responses** - Test resilience to unexpected AI output formats
- ❌ **Extension activation failures** - Validate error reporting when extension fails to start
- ❌ **Timeout handling recovery** - Test retry logic and recovery from timeouts

### Multiple Interactions
- ❌ **Multiple sequential AI interactions** - Verify proper attribution tracking across multiple prompts
- ❌ **Concurrent AI requests** - Test behavior with parallel AI operations

### Edge Cases
- ❌ **Empty prompts** - Validate handling of empty or whitespace-only prompts
- ❌ **Very large responses** - Test with responses exceeding expected size limits
- ❌ **Special characters** - Verify handling of unicode, emojis, and control characters in code

### Integration Testing
- ❌ **Real API endpoint testing** - Optional integration tests against production/staging API
- ❌ **Different AI models** - Test with various model versions and configurations
- ❌ **Cross-IDE compatibility** - Comprehensive testing across all supported IDEs

**Note**: Current E2E tests focus on the happy path to validate core functionality. These missing scenarios represent areas for future test coverage expansion.

## See Also

- [LESSONS.md](./LESSONS.md) - Detailed technical learnings and troubleshooting
- [cursor/docker/Dockerfile](./cursor/docker/Dockerfile) - Cursor Docker configuration
- [vscode/docker/Dockerfile](./vscode/docker/Dockerfile) - VS Code Docker configuration
- [.github/workflows/cursor-e2e.yml](../../../../.github/workflows/cursor-e2e.yml) - Cursor CI workflow
- [.github/workflows/vscode-e2e.yml](../../../../.github/workflows/vscode-e2e.yml) - VS Code CI workflow
