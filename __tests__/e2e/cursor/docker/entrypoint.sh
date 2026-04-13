#!/bin/bash
set -e

echo "🚀 Starting Cursor E2E Test Container"

# Check if a fresh VSIX was mounted from host
# Note: package:test script cleans up old VSIX files, so there should only be one
VSIX_FILE=$(ls /host-vsix/mobb-ai-tracer-*.vsix 2>/dev/null | head -1)

if [ -n "$VSIX_FILE" ] && [ -f "$VSIX_FILE" ]; then
  echo "📦 Fresh VSIX detected from host, copying to workspace..."
  echo "  Using: $VSIX_FILE"

  # Copy the VSIX directly — esbuild bundles everything, no native modules to rebuild
  cp "$VSIX_FILE" /workspace/clients/tracer_ext/

  VSIX_BASENAME=$(basename "$VSIX_FILE")
  VSIX_PATH="/workspace/clients/tracer_ext/$VSIX_BASENAME"

  # Validate the VSIX exists and has reasonable size
  if [ ! -f "$VSIX_PATH" ]; then
    echo "❌ ERROR: VSIX not found at $VSIX_PATH"
    exit 1
  fi

  VSIX_SIZE=$(stat -c%s "$VSIX_PATH" 2>/dev/null || stat -f%z "$VSIX_PATH" 2>/dev/null || echo "0")
  if [ "$VSIX_SIZE" -lt 100000 ]; then
    echo "❌ ERROR: VSIX is suspiciously small ($VSIX_SIZE bytes)"
    exit 1
  fi

  echo "✅ VSIX ready for testing"
  ls -lh "$VSIX_PATH"
else
  echo "📦 No fresh VSIX mounted, using image-bundled VSIX"
  # The VSIX should already be in /workspace/clients/tracer_ext/
  if ! ls /workspace/clients/tracer_ext/mobb-ai-tracer-*.vsix >/dev/null 2>&1; then
    echo "❌ ERROR: No VSIX found in image. This should not happen."
    exit 1
  fi
fi

# Execute the main command (run the test)
exec "$@"
