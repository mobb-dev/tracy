#!/bin/bash
set -e

echo "🚀 Starting Cursor E2E Test Container"

# Check if a fresh VSIX was mounted from host
# Note: package:test script cleans up old VSIX files, so there should only be one
VSIX_FILE=$(ls /host-vsix/mobb-ai-tracer-*.vsix 2>/dev/null | head -1)

if [ -n "$VSIX_FILE" ] && [ -f "$VSIX_FILE" ]; then
  echo "📦 Fresh VSIX detected from host, repackaging with Linux-native modules..."
  echo "  Using: $VSIX_FILE"

  # Clean up any existing staging directory
  rm -rf /tmp/vsix-staging
  mkdir -p /tmp/vsix-staging

  # Extract VSIX
  echo "  Extracting VSIX..."
  unzip -q "$VSIX_FILE" -d /tmp/vsix-staging

  # Install Linux-native modules (better-sqlite3)
  echo "  Installing Linux-native modules..."
  cd /tmp/vsix-staging/extension

  # Remove existing node_modules for native deps
  rm -rf node_modules/better-sqlite3

  # Reinstall better-sqlite3 with Linux binaries
  # Use version from package.json or fall back to known version
  SQLITE_VERSION=$(node -p "require('./package.json').dependencies?.['better-sqlite3'] || require('./package.json').devDependencies?.['better-sqlite3'] || '12.5.0'" 2>/dev/null || echo "12.5.0")
  echo "  Installing better-sqlite3@${SQLITE_VERSION}..."

  # Install with proper error handling (use --loglevel=error to suppress warnings)
  if ! npm install --no-save --loglevel=error "better-sqlite3@${SQLITE_VERSION}"; then
    echo "❌ ERROR: Failed to install better-sqlite3@${SQLITE_VERSION}"
    exit 1
  fi

  # Verify the module was installed correctly
  if [ ! -d "node_modules/better-sqlite3" ]; then
    echo "❌ ERROR: better-sqlite3 module not found after installation"
    exit 1
  fi

  cd /tmp/vsix-staging

  # Repackage VSIX with Linux-native modules
  echo "  Repackaging VSIX..."
  if ! zip -r /workspace/clients/tracer_ext/mobb-ai-tracer-linux.vsix . >/dev/null 2>&1; then
    echo "❌ ERROR: Failed to repackage VSIX"
    exit 1
  fi

  # Validate the repackaged VSIX exists and has reasonable size
  VSIX_PATH="/workspace/clients/tracer_ext/mobb-ai-tracer-linux.vsix"
  if [ ! -f "$VSIX_PATH" ]; then
    echo "❌ ERROR: Repackaged VSIX not found at $VSIX_PATH"
    exit 1
  fi

  VSIX_SIZE=$(stat -c%s "$VSIX_PATH" 2>/dev/null || stat -f%z "$VSIX_PATH" 2>/dev/null || echo "0")
  if [ "$VSIX_SIZE" -lt 100000 ]; then
    echo "❌ ERROR: Repackaged VSIX is suspiciously small ($VSIX_SIZE bytes)"
    exit 1
  fi

  echo "✅ VSIX repackaged with Linux-native modules"
  ls -lh "$VSIX_PATH"

  # Clean up
  rm -rf /tmp/vsix-staging
else
  echo "📦 No fresh VSIX mounted, using image-bundled VSIX"
  # The linux VSIX should already be in /workspace/clients/tracer_ext/
  if [ ! -f /workspace/clients/tracer_ext/mobb-ai-tracer-linux.vsix ]; then
    echo "❌ ERROR: No VSIX found in image. This should not happen."
    exit 1
  fi
fi

# Execute the main command (run the test)
exec "$@"
