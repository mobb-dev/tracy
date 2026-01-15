#!/bin/bash
set -e

echo "========================================"
echo "Local Copilot Authentication Capture"
echo "========================================"
echo ""
echo "This script will:"
echo "1. Launch VS Code with a test profile"
echo "2. You manually sign in to Copilot"
echo "3. Capture the authenticated state for Docker testing"
echo ""

# Create temporary test profile
TEST_PROFILE_DIR="/tmp/vscode-copilot-auth-capture-$(date +%s)"
mkdir -p "$TEST_PROFILE_DIR"
echo "✓ Created test profile: $TEST_PROFILE_DIR"

# Find VS Code executable
if [ -f "/Applications/Visual Studio Code.app/Contents/MacOS/Electron" ]; then
    VSCODE_PATH="/Applications/Visual Studio Code.app/Contents/MacOS/Electron"
elif [ -f "/usr/local/bin/code" ]; then
    VSCODE_PATH="/usr/local/bin/code"
elif [ -f "/usr/bin/code" ]; then
    VSCODE_PATH="/usr/bin/code"
else
    echo "❌ VS Code not found. Please install VS Code first."
    exit 1
fi

echo "✓ Found VS Code at: $VSCODE_PATH"

# Check if Copilot extensions are installed in user's home
COPILOT_EXT=$(ls -d ~/.vscode/extensions/github.copilot-* 2>/dev/null | head -1 || echo "")
COPILOT_CHAT_EXT=$(ls -d ~/.vscode/extensions/github.copilot-chat* 2>/dev/null | head -1 || echo "")

if [ -z "$COPILOT_EXT" ] || [ -z "$COPILOT_CHAT_EXT" ]; then
    echo "⚠️  Copilot extensions not found in ~/.vscode/extensions/"
    echo "   Please install GitHub Copilot and Copilot Chat extensions first"
    echo "   Run: code --install-extension github.copilot"
    echo "   Run: code --install-extension github.copilot-chat"
    exit 1
fi

echo "✓ Found Copilot extension: $(basename $COPILOT_EXT)"
echo "✓ Found Copilot Chat extension: $(basename $COPILOT_CHAT_EXT)"

# Copy Copilot extensions to test profile
EXTENSIONS_DIR="$TEST_PROFILE_DIR/User/extensions"
mkdir -p "$EXTENSIONS_DIR"
cp -r "$COPILOT_EXT" "$EXTENSIONS_DIR/"
cp -r "$COPILOT_CHAT_EXT" "$EXTENSIONS_DIR/"
echo "✓ Copied Copilot extensions to test profile"

# Create settings to auto-enable Copilot
SETTINGS_FILE="$TEST_PROFILE_DIR/User/settings.json"
cat > "$SETTINGS_FILE" << 'EOF'
{
  "github.copilot.enable": {
    "*": true
  }
}
EOF
echo "✓ Created VS Code settings"

echo ""
echo "=========================================="
echo "MANUAL STEP: Sign in to Copilot"
echo "=========================================="
echo ""
echo "VS Code will now launch. Please:"
echo "1. Click on the Copilot icon in the bottom right"
echo "2. Click 'Sign in to GitHub'"
echo "3. Complete the GitHub OAuth flow in your browser"
echo "4. Verify Copilot is working (try opening Copilot Chat)"
echo "5. Close VS Code when done"
echo ""
echo "Press Enter to launch VS Code..."
read

# Launch VS Code with test profile
echo "Launching VS Code..."
"$VSCODE_PATH" --user-data-dir="$TEST_PROFILE_DIR" --extensions-dir="$EXTENSIONS_DIR" &
VSCODE_PID=$!

echo "VS Code launched (PID: $VSCODE_PID)"
echo ""
echo "Waiting for you to sign in to Copilot..."
echo "Close VS Code when authentication is complete."
echo ""

# Wait for VS Code to exit
wait $VSCODE_PID

echo ""
echo "=========================================="
echo "Extracting Authentication State"
echo "=========================================="
echo ""

# Check if state.vscdb was created
STATE_DB="$TEST_PROFILE_DIR/User/globalStorage/state.vscdb"
if [ ! -f "$STATE_DB" ]; then
    echo "❌ state.vscdb not found at: $STATE_DB"
    echo "   Authentication may not have completed."
    exit 1
fi

echo "✓ Found state.vscdb ($(wc -c < "$STATE_DB") bytes)"

# Try to extract Copilot tokens from macOS keychain
echo ""
echo "Attempting to extract Copilot tokens from keychain..."
KEYCHAIN_DUMP_FILE="$TEST_PROFILE_DIR/keychain-tokens.txt"

# Query macOS keychain for VS Code GitHub auth entries
security find-generic-password -s "vscode.github-authentication" -g 2>&1 | grep -E "(account|password)" > "$KEYCHAIN_DUMP_FILE" || true

if [ -s "$KEYCHAIN_DUMP_FILE" ]; then
    echo "✓ Found keychain entries"
else
    echo "⚠️  No keychain entries found (may not be stored in keychain)"
fi

# Compress and encode the entire profile for Docker
OUTPUT_DIR="$(dirname $0)/.."
OUTPUT_FILE="$OUTPUT_DIR/vscode-copilot-auth-macos.b64"

echo ""
echo "Compressing and encoding profile..."
cd "$TEST_PROFILE_DIR"
tar czf - User/ | base64 > "$OUTPUT_FILE"

echo "✓ Created: $OUTPUT_FILE"
echo "  Size: $(wc -c < "$OUTPUT_FILE") bytes (base64 encoded)"

# Also create a separate file with just state.vscdb
STATE_OUTPUT="$OUTPUT_DIR/vscode-state-copilot-macos.b64"
gzip -c "$STATE_DB" | base64 > "$STATE_OUTPUT"
echo "✓ Created: $STATE_OUTPUT"
echo "  Size: $(wc -c < "$STATE_OUTPUT") bytes (base64 encoded)"

# Cleanup
echo ""
echo "Cleaning up temporary profile..."
rm -rf "$TEST_PROFILE_DIR"

echo ""
echo "=========================================="
echo "✅ SUCCESS!"
echo "=========================================="
echo ""
echo "Authentication captured. You can now use these files in Docker:"
echo "  1. $OUTPUT_FILE (full profile)"
echo "  2. $STATE_OUTPUT (state.vscdb only)"
echo ""
echo "To use in Docker, set environment variable:"
echo "  export VSCODE_STATE_VSCDB_B64=\$(cat $STATE_OUTPUT)"
echo ""
