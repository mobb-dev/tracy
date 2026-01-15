# Copilot Authentication for Docker E2E Tests

## Problem

VS Code Copilot stores authentication tokens in the system keychain:
- **macOS**: Keychain Access (encrypted with machine-specific keys)
- **Linux**: gnome-keyring (doesn't work reliably in Docker)

Even with valid GitHub OAuth tokens in `state.vscdb`, Copilot fails in Docker because it can't read tokens from gnome-keyring.

## Solution: Capture Authentication Locally

### Step 1: Capture Copilot Auth on macOS

Run the capture script to sign in to Copilot locally:

```bash
cd /Users/lioror/proj/autofixer2/clients/tracer_ext
./tests__/e2e/vscode/scripts/capture-local-copilot-auth.sh
```

This will:
1. Launch VS Code with a test profile
2. Prompt you to sign in to Copilot manually
3. Capture the authenticated state
4. Create two files:
   - `vscode-copilot-auth-macos.b64` - full profile (tar.gz + base64)
   - `vscode-state-copilot-macos.b64` - state.vscdb only (gzip + base64)

### Step 2: Understanding the Limitation

⚠️ **Important**: macOS Keychain tokens are encrypted with machine-specific keys and **cannot be decrypted on Linux**.

The captured `state.vscdb` contains:
- ✅ GitHub OAuth sessions
- ✅ VS Code extension state
- ❌ Copilot-specific tokens (these are in macOS Keychain, not exportable)

### Step 3: Alternative Approaches

Since we can't export the macOS keychain, we have these options:

#### Option A: Mock Copilot API (Recommended for CI/CD)
- Intercept Copilot API calls in the test
- Mock the responses to test inference capture
- Doesn't require real Copilot authentication

#### Option B: Use Cursor Instead
- Cursor might have different auth mechanism
- Worth testing if Cursor stores auth differently

#### Option C: Test Locally Only
- Run E2E tests on macOS where keychain works
- Skip Docker-based testing for Copilot

#### Option D: Programmatic Token Injection
- Get Copilot token via GitHub API
- Inject it into gnome-keyring programmatically in Docker
- Requires understanding Copilot's exact token format

## Current Test Status

### Working (5/8 checkpoints passing):
- ✅ VS Code installation
- ✅ Extension installation (Copilot + Mobb)
- ✅ Mobb extension authentication
- ✅ Extension activation
- ✅ Copilot panel opening

### Blocked by Keyring:
- ❌ Copilot authentication (needs keyring)
- ❌ Copilot prompt sending (blocked by auth)
- ❌ Inference capture (blocked by auth)

## Next Steps

1. **Try the capture script** to see what we can extract
2. **Inspect captured files** to understand what's portable
3. **Consider Option A (mocking)** if real auth proves impossible
4. **Test with Cursor** as alternative

## Files Created

- `scripts/capture-local-copilot-auth.sh` - Capture script for macOS
- `scripts/inject-copilot-auth.sh` - Injection script for Docker (WIP)
- `COPILOT_AUTH_GUIDE.md` - This guide
