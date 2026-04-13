#!/bin/bash
set -e

echo "🚀 Starting VS Code E2E Test Container"

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
