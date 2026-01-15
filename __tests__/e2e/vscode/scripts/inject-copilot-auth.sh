#!/bin/bash
# This script runs INSIDE Docker to inject captured Copilot authentication

set -e

AUTH_FILE="${1:-/workspace/clients/tracer_ext/__tests__/e2e/vscode/vscode-copilot-auth-macos.b64}"
TARGET_PROFILE="${2:-/tmp/e2e/vscode-profile}"

if [ ! -f "$AUTH_FILE" ]; then
    echo "❌ Auth file not found: $AUTH_FILE"
    exit 1
fi

echo "🔐 Injecting Copilot authentication..."
echo "  Source: $AUTH_FILE"
echo "  Target: $TARGET_PROFILE"

# Extract and decompress the profile
mkdir -p "$TARGET_PROFILE"
cd "$TARGET_PROFILE"
base64 -d "$AUTH_FILE" | tar xzf -

echo "✅ Authentication injected"

# List what was extracted
echo ""
echo "Extracted files:"
find User/ -type f -name "*.vscdb" -o -name "*.json" | head -10

# Check if state.vscdb exists
if [ -f "User/globalStorage/state.vscdb" ]; then
    SIZE=$(wc -c < "User/globalStorage/state.vscdb")
    echo ""
    echo "✅ Found state.vscdb ($SIZE bytes)"
else
    echo ""
    echo "⚠️  state.vscdb not found"
fi
