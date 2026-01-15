# Claude Code E2E Test Migration to Vitest

This document describes the migration of the Claude Code E2E test from a standalone TypeScript script to vitest.

## Files

- **claude-code-e2e.test.ts** - New vitest-based test (current)
- **claude-code-e2e.test.old.ts** - Original standalone script (deprecated)

## What Changed

### Before (Standalone Script)
```typescript
// Plain async function
async function runClaudeCodeE2ETest(): Promise<void> {
  // Test logic...
}

// Manual execution
runClaudeCodeE2ETest()
  .then(() => process.exit(0))
  .catch(() => process.exit(1))
```

**Issues:**
- Not integrated with test framework
- Manual setup/teardown management
- No standard test reporting
- Hard to run selectively
- Inconsistent with other tests (extension.test.ts uses vitest)

### After (Vitest)
```typescript
import { expect, test } from 'vitest'

test.describe('Claude Code E2E with Hook Integration', () => {
  // Shared variables
  let mockServer: MockUploadServer | null = null
  // ...

  test.afterEach(async () => {
    // Automatic cleanup
  })

  test('should capture and upload AI attribution via hook', async () => {
    // Test logic with expect() assertions
  }, { timeout: TEST_TIMEOUT })
})
```

**Benefits:**
- Standard test framework integration
- Automatic setup/teardown with lifecycle hooks
- Standard test reporting format
- Can run with other tests: `npm test`
- Consistent with project testing patterns
- Better error handling and reporting
- IDE integration (test runner, debugging)

## Key Improvements

### 1. Test Framework Integration
- Uses vitest's `describe()` and `test()` for proper test structure
- Integrates with existing test suite
- Standard TAP/JSON test output

### 2. Lifecycle Management
- `afterEach()` hook ensures cleanup runs even if test fails
- No manual try/catch/finally blocks needed
- Test framework handles exit codes

### 3. Assertions
Changed from:
```typescript
if (exitCode !== 0) {
  throw new Error(`Claude Code exited with code ${exitCode}`)
}
```

To:
```typescript
expect(exitCode).toBe(0)
```

Benefits:
- Better error messages
- Standard assertion format
- Test framework integration

### 4. Timeout Configuration
Changed from:
```typescript
const timeout = setTimeout(() => {
  claudeProcess?.kill('SIGKILL')
  reject(new Error(`Claude Code timed out after ${CLAUDE_CODE_TIMEOUT}ms`))
}, CLAUDE_CODE_TIMEOUT)
```

To:
```typescript
test('should capture...', async () => {
  // test logic
}, { timeout: TEST_TIMEOUT })
```

Benefits:
- Test framework manages timeouts
- Consistent timeout handling
- Better timeout reporting

## Running the Tests

### Development (Local)
```bash
# Run all vitest tests (including Claude Code E2E)
npm test

# Run only Claude Code E2E test
npm test claude-code-e2e

# Watch mode for development
npm test -- --watch
```

### CI/Docker (Full E2E)
```bash
# Docker-based test (unchanged)
npm run test:e2e:claude-code:full
```

The Docker test now uses vitest internally via `npx vitest run`.

## Migration Checklist

- [x] Create vitest version with describe/test blocks
- [x] Add proper lifecycle hooks (afterEach)
- [x] Replace manual assertions with expect()
- [x] Add test timeout configuration
- [x] Verify test runs with `npm test`
- [x] Update Docker entrypoint to use vitest
- [x] Deprecate old standalone script
- [x] Document migration

## Backward Compatibility

The old standalone script is preserved as `claude-code-e2e.test.old.ts` for reference.
It can be removed in a future cleanup once the vitest version is validated in CI.

To run the old version (not recommended):
```bash
tsx __tests__/e2e/claude-code/claude-code-e2e.test.old.ts
```

## Related Tests

Other E2E tests in the project:
- `__tests__/extension.test.ts` - Extension unit tests (vitest) ✅
- `__tests__/e2e/cursor/playwright-automation.test.ts` - Cursor E2E (Playwright + test framework) ✅
- `__tests__/e2e/vscode/*` - VS Code E2E (Playwright + test framework) ✅

All tests now use proper test frameworks for consistency.
