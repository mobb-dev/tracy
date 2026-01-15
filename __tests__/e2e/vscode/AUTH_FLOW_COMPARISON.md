# VS Code E2E Auth Flow Comparison

## Overview

Comparing the **Manual VNC Flow** (pre-built auth) vs **Current Device Flow OAuth** implementation.

---

## Authentication Method Priority

### OLD (Manual VNC Flow - Commit before 161c6b646)

```
Priority Order:
1. VSCODE_AUTH_DIR (env var with auth directory)
2. VSCODE_STATE_VSCDB_B64 (pre-built Linux auth - THE PRIMARY METHOD)
3. Local auth files (vscode-auth-linux.b64 / vscode-auth.b64)
4. Local VS Code installation
5. Device Flow OAuth (FALLBACK ONLY)
```

**Key Characteristic**: Uses **pre-generated Linux-native auth** created via manual VNC capture

### CURRENT (Device Flow First - Current HEAD)

```
Priority Order:
1. Device Flow OAuth (PRIORITY 1 - PRIMARY METHOD)
   - Creates fresh tokens via automated GitHub login
   - Stores in state.vscdb
   - Authenticates gh CLI
   - Attempts gnome-keyring storage
2. VSCODE_AUTH_DIR (fallback)
3. VSCODE_STATE_VSCDB_B64 (fallback with expiry warning)
4. Local auth files (fallback)
5. Local VS Code installation (fallback)
```

**Key Characteristic**: Tries to **automate everything** with Device Flow OAuth first

---

## Key Differences in setupAuth() Function

### 1. Return Type

**OLD:**
```typescript
async function setupAuth(globalStorageDir: string): Promise<boolean>
```
- Returns simple boolean

**CURRENT:**
```typescript
async function setupAuth(globalStorageDir: string): Promise<AuthResult>
```
- Returns `{ authSetup: boolean, deviceFlowSuccess: boolean }`
- Tracks whether Device Flow specifically succeeded

### 2. Auth Priority Logic

**OLD (Lines 1-160 of setupAuth):**
- Checks pre-built auth FIRST
- Only tries Device Flow if nothing else exists
- Device Flow is **Option 5** (last resort)

**CURRENT (Lines 1-220 of setupAuth):**
- Tries Device Flow FIRST if credentials available
- Pre-built auth becomes fallback
- Device Flow is **PRIORITY 1**
- Adds gh CLI authentication
- Adds gnome-keyring storage attempt

### 3. Token Storage Locations

**OLD:**
```
✓ state.vscdb only
```

**CURRENT:**
```
✓ state.vscdb
✓ gh CLI (via gh auth login)
✓ gnome-keyring (via storeTokenInKeyring() - NEW)
```

### 4. Gnome-Keyring Integration

**OLD:**
- No gnome-keyring storage
- No `storeTokenInKeyring()` function

**CURRENT:**
- Added `storeTokenInKeyring()` function (lines 2181-2372)
- Extensive debugging (lines 2190-2278)
- Tries multiple key formats
- Has timeouts and diagnostics

---

## Other Test Changes (May Want to Keep)

### 1. Extension Log Capture (Commit 3daab8307)
```typescript
// NEW function added:
async function captureExtensionLogs(
  mainWindow: Page,
  electronApp: ElectronApplication,
  outputFileName: string = 'extension-output.txt'
): Promise<string>
```
**Purpose**: Captures logs from VS Code Output panel for debugging
**Location**: Lines 1979-2128
**Status**: ✅ USEFUL - Helps debug test failures

### 2. ChatML Success Fallback (Commit b197e9d94)
**Extension Changes** (not test file):
- Added fallback inference extraction from ChatMLSuccess tool calls
- Better VS Code Copilot compatibility
**Status**: ✅ USEFUL - Improves extension robustness

### 3. Auto-Accept Copilot Settings (Commit 31d9d92ca)
```typescript
// Added to settings.json:
'chat.editing.autoAcceptDelay': 500,
'chat.editing.confirmEditRequestRemoval': false,
'chat.editing.confirmEditRequestRetry': false,
'github.copilot.chat.edits.allowFilesOutsideWorkspace': true,
'chat.tools.global.autoApprove': true,  // ⚠️ Disables security!
'chat.tools.terminal.autoApprove': true,
```
**Status**: ⚠️ SECURITY CONCERN but needed for automated testing

### 4. Permission Dialog Handling (Commit ac1c30f61)
```typescript
// Enhanced "Allow edits" dialog detection with multiple selectors
const allowSelectors = [
  'button:has-text("Allow")',
  '[role="button"]:has-text("Allow")',
  '.monaco-button:has-text("Allow")',
  'a:has-text("Allow")',
  'text=/^Allow/i',
]
```
**Status**: ✅ USEFUL - Better dialog handling

### 5. Email Verification for Device Flow (Commit 4835439aa)
- Added GitHub Device Verification (not 2FA) support
- Uses IMAP to fetch verification codes from email
**Status**: ⚠️ Only needed for Device Flow OAuth

### 6. Timing & Logging Improvements
- Better timestamp logging (`logTimestamp()`)
- Checkpoint status tracking
- Screenshot naming improvements
**Status**: ✅ USEFUL - Better debugging

---

## Recommendation

### What to Keep from Current Version:
1. ✅ `captureExtensionLogs()` function - very useful for debugging
2. ✅ Permission dialog handling improvements
3. ✅ Auto-accept Copilot settings (needed for automation)
4. ✅ Timing and logging improvements
5. ✅ Better screenshot organization
6. ✅ Extension changes (ChatML fallback)

### What to Revert:
1. ❌ Device Flow OAuth priority (make it fallback again)
2. ❌ `storeTokenInKeyring()` function (doesn't work reliably)
3. ❌ gh CLI authentication (not needed with pre-built auth)
4. ❌ Email verification logic (only needed for Device Flow)
5. ❌ `AuthResult` return type (revert to simple boolean)

### Proposed Final Auth Priority:
```
1. VSCODE_STATE_VSCDB_B64 (pre-built Linux auth via manual VNC)
2. VSCODE_AUTH_DIR
3. Local auth files (vscode-auth-linux.b64)
4. Local VS Code installation
5. Device Flow OAuth (fallback only, if all else fails)
```

---

## Manual VNC Auth Creation Script

**Location**: `scripts/create-docker-auth.sh`

**Usage**:
```bash
cd clients/tracer_ext/__tests__/e2e/vscode/scripts
./create-docker-auth.sh
```

**What it does**:
1. Builds Docker image with VS Code
2. Starts VNC server on port 5900
3. Opens VS Code with `--password-store=basic`
4. You authenticate via VNC manually
5. Exports Linux-native `vscode-auth-linux.b64`
6. Updates GitHub secret `VSCODE_STATE_VSCDB_B64`

**Why it works**: Authentication happens **inside Linux Docker** with portable password storage.

---

## Next Steps

1. Revert `setupAuth()` function to pre-built auth priority
2. Remove gnome-keyring code
3. Keep test improvements (logging, dialogs, screenshots)
4. Test with fresh manual VNC auth capture
5. Update documentation
