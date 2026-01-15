# VS Code Extension E2E Test Workflow

## Overview

The VS Code E2E tests verify that the Mobb extension works correctly with GitHub Copilot in a real VS Code environment. This guide explains the test workflow and how to use it effectively.

## Two Workflows: Fast Iteration vs Full Rebuild

### Fast Iteration Workflow (Recommended for Development)

Use this when actively developing the extension and want to test changes quickly:

```bash
# 1. Build Docker image ONCE (only needed when VS Code/Copilot versions change)
cd clients/tracer_ext
npm run test:e2e:vscode:build-image

# 2. Run tests with fresh VSIX (repeat as often as needed)
npm run test:e2e:vscode:run-docker
```

**Key Benefits:**
- ✅ **Fast**: No Docker rebuild needed for extension changes
- ✅ **Fresh**: Always uses the latest extension code
- ✅ **Automatic**: `npm run package:test` builds fresh VSIX before each run
- ✅ **Runtime Repackaging**: Entrypoint script repackages VSIX with Linux-native modules

**How It Works:**
1. `npm run package:test` builds a fresh VSIX with latest code
2. Docker container starts with entrypoint script
3. Entrypoint detects mounted VSIX from host (at `/workspace/clients/tracer_ext/host-vsix/`)
4. Entrypoint extracts VSIX, rebuilds native modules for Linux, repackages it
5. Test runs with the freshly repackaged VSIX

### Full Rebuild Workflow (CI/CD or Major Changes)

Use this when:
- Running in CI/CD pipelines
- Updating VS Code or Copilot versions
- Making changes to test infrastructure (Dockerfile, dependencies)

```bash
cd clients/tracer_ext
npm run test:e2e:vscode:full
```

This runs both:
1. `npm run test:e2e:vscode:build-image` - Builds Docker image with bundled VSIX
2. `npm run test:e2e:vscode:run-docker` - Runs tests (will use runtime-mounted VSIX if available)

## Available Commands

### Build Commands

```bash
# Build Docker image with latest VS Code and Copilot
npm run test:e2e:vscode:build-image
```

**When to run:**
- After cloning the repository
- When VS Code or Copilot versions need updating
- When Dockerfile or test infrastructure changes

### Test Commands

```bash
# Run tests with fresh extension build (normal mode)
npm run test:e2e:vscode:run-docker

# Run tests with VNC server for visual debugging
npm run test:e2e:vscode:run-docker-vnc
```

**What happens:**
1. Builds fresh VSIX (`npm run package:test`)
2. Starts Docker container with mounts:
   - `test-results/` - For screenshots and artifacts
   - Current directory (read-only) - For fresh VSIX access
3. Entrypoint script handles VSIX repackaging
4. Tests run in Docker container
5. Screenshot viewer opens automatically

### Debug Commands

```bash
# Run with VNC for visual debugging
npm run test:e2e:vscode:run-docker-vnc

# Then connect VNC viewer to:
# Host: localhost:5900
# Password: (none)

# View screenshots after test
npm run generate-screenshot-viewer
open test-results/screenshot-viewer.html
```

## Understanding the Test Flow

The test goes through these checkpoints:

1. **CHECKPOINT 1**: VS Code Installed ✅
   - Verifies VS Code version (requires >= 1.108.0 for Copilot compatibility)
2. **CHECKPOINT 2**: Copilot Installed ✅
   - Verifies Copilot and Copilot Chat versions
3. **CHECKPOINT 3**: Mobb Extension Installed ✅
   - Installs freshly built VSIX
4. **CHECKPOINT 4**: Mobb Extension Logged In ⏳
   - Waits for extension to activate and make GraphQL requests
5. **CHECKPOINT 5**: Copilot Focused ✅
   - Uses multiple strategies to focus Copilot Chat input
6. **CHECKPOINT 6**: Copilot Prompt Sent ✅
   - Sends test prompt to Copilot
7. **CHECKPOINT 7**: Copilot Finished Generating ⏳
   - Waits for Copilot to complete response
8. **CHECKPOINT 8**: Mobb Extension Captured Inferences ⏳
   - Verifies extension captured the AI interaction

## Extension Build Process

### `npm run package:test`

Creates a test VSIX with:
- Test configuration (`.env` and `runtime.config.json`)
- Points to `http://localhost:3000/graphql` (mock server)
- Includes all dependencies

**File created:** `mobb-ai-tracer-{version}.vsix`

### Entrypoint Repackaging

When Docker container starts:
1. Checks for mounted VSIX at `/workspace/clients/tracer_ext/host-vsix/`
2. If found:
   - Extracts VSIX to temporary directory
   - Reinstalls `better-sqlite3` with Linux-native binaries
   - Repackages as `mobb-ai-tracer-linux.vsix`
3. If not found:
   - Uses bundled VSIX from Docker image (CI workflow)

## Directory Structure

```
clients/tracer_ext/
├── __tests__/e2e/vscode/
│   ├── docker/
│   │   ├── Dockerfile           # Docker image definition
│   │   └── entrypoint.sh        # Runtime VSIX handling
│   ├── playwright-automation.test.ts  # Main test file
│   └── TEST_WORKFLOW.md         # This file
├── test-results/                # Screenshots and artifacts
│   └── screenshot-viewer.html   # Visual test results
├── mobb-ai-tracer-{version}.vsix  # Fresh VSIX (built by package:test)
└── package.json                 # Test scripts
```

## Troubleshooting

### Extension Not Activating (0 GraphQL Requests)

**Symptoms:** CHECKPOINT 4 fails with "0 GraphQL requests after 30s"

**Possible causes:**
1. **Incorrect extension directory naming**
   - Should be: `mobb.mobb-ai-tracer-{version}`
   - Check: Test logs show "Installing VSIX via CLI"

2. **Native module issues** (better-sqlite3)
   - Entrypoint should show "Installing Linux-native modules..."
   - Check: No errors during VSIX repackaging

3. **VS Code version incompatibility**
   - Copilot Chat 0.36.0+ requires VS Code >= 1.108.0
   - Check: CHECKPOINT 1 shows compatible version

**Solutions:**
- Rebuild Docker image: `npm run test:e2e:vscode:build-image`
- Check entrypoint logs for VSIX repackaging
- Verify `package.json` version matches extracted directory name

### Copilot Input Not Focusing (CHECKPOINT 5 Fails)

**Symptoms:** Test times out trying to focus Copilot Chat input

**Solutions:**
1. Run with VNC to see visual state: `npm run test:e2e:vscode:run-docker-vnc`
2. Check screenshots in `test-results/` directory
3. Test uses 6 different focus strategies - check which ones failed in logs

### Docker Build Failures

**Common issues:**
1. **VS Code requires --no-sandbox** when running as root
   - Already handled in Dockerfile

2. **Architecture mismatch** (amd64 vs arm64)
   - Dockerfile uses Microsoft repo which auto-selects architecture

3. **VSIX not found** during build
   - Run `npm run package:test` before building image
   - Or use runtime mounting workflow (faster)

## CI/CD Integration

For CI/CD pipelines, use the full workflow:

```yaml
# Example GitHub Actions
- name: Run VS Code E2E Tests
  run: |
    cd clients/tracer_ext
    npm run test:e2e:vscode:full
```

This ensures:
- Fresh Docker image with latest VS Code/Copilot
- Bundled VSIX in image (no host mounting dependency)
- All test artifacts exported to `test-results/`

## Performance Considerations

### Docker Image Size
- **With bundled VSIX**: ~2.5 GB (includes VS Code, Copilot, dependencies)
- **Without bundled VSIX**: ~2.4 GB (minimal difference)

### Build Times
- **Full rebuild**: ~5-10 minutes (installs VS Code, Copilot, npm packages)
- **Test run only**: ~2-3 minutes (with VSIX repackaging)
- **Extension rebuild**: ~10-30 seconds (`npm run package:test`)

### Recommended Workflow
1. Build image once per session: `npm run test:e2e:vscode:build-image`
2. Iterate quickly: `npm run test:e2e:vscode:run-docker` (uses runtime mounting)
3. Full rebuild only when needed (VS Code/Copilot updates)

## Environment Variables

### Required
- `VSCODE_STATE_VSCDB_B64`: Pre-authenticated VS Code state (includes Copilot auth)
  - Created via: `__tests__/e2e/vscode/scripts/create-docker-auth.sh`
  - Stored in: `__tests__/e2e/vscode/auth/vscode-auth-linux.b64`

### Optional
- `ENABLE_VNC=true`: Start VNC server for visual debugging (port 5900)

## Advanced Usage

### Run Specific Test Only

```bash
# Build fresh VSIX
npm run package:test

# Run Docker with custom command
docker run --rm \
  -e VSCODE_STATE_VSCDB_B64="$(cat __tests__/e2e/vscode/auth/vscode-auth-linux.b64)" \
  -v $(pwd)/test-results:/workspace/clients/tracer_ext/test-results \
  -v $(pwd):/workspace/clients/tracer_ext/host-vsix:ro \
  tracer-ext-vscode-e2e \
  /bin/bash -c "cd /workspace/clients/tracer_ext && npm test -- --grep 'specific test name'"
```

### Debug Container Without Running Tests

```bash
docker run --rm -it \
  -e VSCODE_STATE_VSCDB_B64="$(cat __tests__/e2e/vscode/auth/vscode-auth-linux.b64)" \
  -v $(pwd):/workspace/clients/tracer_ext/host-vsix:ro \
  tracer-ext-vscode-e2e \
  /bin/bash
```

### Inspect VSIX Repackaging

```bash
# Check entrypoint logs (shown during container start)
docker run --rm \
  -v $(pwd):/workspace/clients/tracer_ext/host-vsix:ro \
  tracer-ext-vscode-e2e \
  /bin/bash -c "cat /usr/local/bin/entrypoint.sh"
```

## See Also

- [STATUS.md](./STATUS.md) - Current test status and recent changes
- [AUTH_FLOW_COMPARISON.md](./AUTH_FLOW_COMPARISON.md) - Copilot authentication methods
- [COPILOT_AUTH_GUIDE.md](./COPILOT_AUTH_GUIDE.md) - Creating authentication files
