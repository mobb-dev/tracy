#!/bin/bash
set -e

echo "🚀 Starting VS Code E2E Test Container"

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
  npm install --no-save "better-sqlite3@${SQLITE_VERSION}" 2>&1 | grep -v "npm warn" || echo "  ⚠️ SQLite install had warnings (may be OK)"

  cd /tmp/vsix-staging

  # Repackage VSIX with Linux-native modules
  echo "  Repackaging VSIX..."
  zip -r /workspace/clients/tracer_ext/mobb-ai-tracer-linux.vsix . >/dev/null 2>&1

  echo "✅ VSIX repackaged with Linux-native modules"
  ls -lh /workspace/clients/tracer_ext/mobb-ai-tracer-linux.vsix

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
