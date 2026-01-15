#!/bin/bash
# Create VS Code auth credentials inside Docker for CI testing
#
# This script is needed because VS Code's safeStorage encryption is machine-specific.
# Credentials encrypted on macOS cannot be decrypted on Linux Docker.
#
# This script:
# 1. Builds and runs the VS Code E2E Docker container interactively
# 2. Opens VS Code with VNC so you can do GitHub OAuth login
# 3. Exports the Linux-native state.vscdb after authentication
#
# Usage:
#   ./create-docker-auth.sh
#
# After running, the exported auth will be at:
#   __tests__/e2e/vscode/vscode-auth-linux.b64
#
# Then update the CI secret VSCODE_STATE_VSCDB_B64 with the contents of this file.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# scripts -> vscode -> e2e -> __tests__ -> tracer_ext
TRACER_EXT_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
# tracer_ext -> clients -> autofixer2
REPO_ROOT="$(cd "$TRACER_EXT_DIR/../.." && pwd)"

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║   Create VS Code Auth for Docker/CI                            ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Check if Docker is available
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed or not in PATH"
    exit 1
fi

# Check for --rebuild flag
REBUILD=false
if [ "$1" = "--rebuild" ]; then
    REBUILD=true
    echo "🔄 Rebuild flag detected - will rebuild Docker image"
fi

# Check if Docker image already exists
IMAGE_EXISTS=$(docker images -q tracer-ext-vscode-auth 2>/dev/null)

if [ -n "$IMAGE_EXISTS" ] && [ "$REBUILD" = false ]; then
    echo "✅ Docker image already exists (tracer-ext-vscode-auth)"
    echo "   Skipping build (use --rebuild to force rebuild)"
    echo ""
else
    echo "📦 Building Docker image..."
    echo "   (This may take 2-3 minutes on first run)"
    echo ""
    cd "$REPO_ROOT"
    docker build \
        --tag tracer-ext-vscode-auth \
        --file clients/tracer_ext/__tests__/e2e/vscode/docker/Dockerfile \
        . 2>&1 | tail -20

    echo ""
    echo "✅ Docker image built"
    echo ""
fi

# Create a temporary directory for the auth profile
AUTH_PROFILE_DIR="$TRACER_EXT_DIR/test-results/docker-auth-profile"
mkdir -p "$AUTH_PROFILE_DIR"
chmod 777 "$AUTH_PROFILE_DIR"

echo "════════════════════════════════════════════════════════════════"
echo "Starting VS Code in Docker with VNC..."
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "📺 VNC will be available at: vnc://localhost:5900"
echo "   (Use a VNC client like 'Screen Sharing' on macOS or TigerVNC)"
echo ""
echo "📋 Steps to authenticate:"
echo "   1. Connect to VNC at localhost:5900"
echo "   2. In the VS Code window, sign in to GitHub when prompted"
echo "   3. Install/enable GitHub Copilot if needed"
echo "   4. Make sure Copilot is authenticated (check status bar)"
echo "   5. Press Ctrl+C in this terminal when done"
echo ""
echo "Starting in 3 seconds..."
sleep 3

# Create the auth export script
cat > "$AUTH_PROFILE_DIR/export-auth.sh" << 'EXPORT_SCRIPT'
#!/bin/bash
# Export auth after VS Code closes
AUTH_DIR="/tmp/auth-profile/User/globalStorage"
OUTPUT_FILE="/workspace/clients/tracer_ext/test-results/docker-auth-profile/state.vscdb"

if [ -f "$AUTH_DIR/state.vscdb" ]; then
    cp "$AUTH_DIR/state.vscdb" "$OUTPUT_FILE"
    echo "✅ Exported state.vscdb to $OUTPUT_FILE"
else
    echo "❌ No state.vscdb found"
fi
EXPORT_SCRIPT
chmod +x "$AUTH_PROFILE_DIR/export-auth.sh"

# Run Docker with VNC enabled
# Note: Removed -it flag to allow running without TTY (for automation)
# The container will keep running until you press Ctrl+C or close VS Code
docker run --rm \
    -p 5900:5900 \
    -e ENABLE_VNC=true \
    -e DISPLAY=:99 \
    -v "$AUTH_PROFILE_DIR:/workspace/clients/tracer_ext/test-results/docker-auth-profile" \
    tracer-ext-vscode-auth \
    /bin/bash -c '
        # Start Xvfb
        Xvfb :99 -screen 0 1920x1080x24 &
        sleep 2

        # Start VNC with clipboard support
        # -clip: Enable clipboard sharing between client and server
        x11vnc -display :99 -forever -nopw -quiet -bg -clip both
        echo "VNC server started on port 5900 (with clipboard support)"

        # Start openbox window manager for window management
        echo "Starting openbox window manager..."
        openbox &
        sleep 1
        echo "✅ Window manager started"

        # Create auth profile directory
        mkdir -p /tmp/auth-profile/User/globalStorage
        mkdir -p /tmp/auth-profile/User/extensions

        # Copy Copilot extensions
        cp -r /opt/copilot-extensions/* /tmp/auth-profile/User/extensions/ 2>/dev/null || true

        # Create settings
        mkdir -p /tmp/auth-profile/User
        echo '\''{"security.workspace.trust.enabled": false}'\'' > /tmp/auth-profile/User/settings.json

        # Create a credentials helper file on the desktop for easy copy/paste
        # Note: Container runs as testuser, so use /home/testuser/Desktop
        mkdir -p /home/testuser/Desktop
        chown testuser:testuser /home/testuser/Desktop
        cat > /home/testuser/Desktop/CREDENTIALS.txt << '\''CREDS_EOF'\''
==================================================
GITHUB CREDENTIALS HELPER
==================================================

Ready to use credentials for GitHub authentication.
Copy these credentials and paste into VS Code.

==================================================

GitHub Email/Username:
citestjob@mobb.ai

GitHub Password:
husQy6-cynwov-rorqox

==================================================

Instructions:
1. In VS Code, click "Sign in" when prompted
2. Select and copy the email above (Ctrl+C)
3. Paste into GitHub login (Ctrl+V)
4. Copy and paste the password similarly

After authenticating:
- Make sure Copilot is installed and signed in
- Close VS Code completely (File → Exit)
- The auth will be exported automatically

==================================================
CREDS_EOF
        chown testuser:testuser /home/testuser/Desktop/CREDENTIALS.txt

        # Launch VS Code for authentication
        echo ""
        echo "════════════════════════════════════════════════════════════════"
        echo "VS Code is starting..."
        echo "Connect via VNC to localhost:5900"
        echo "Press Ctrl+C when done authenticating"
        echo "════════════════════════════════════════════════════════════════"

        /usr/share/code/code \
            --user-data-dir=/tmp/auth-profile \
            --extensions-dir=/tmp/auth-profile/User/extensions \
            --no-sandbox \
            --disable-gpu \
            --password-store=basic \
            /home/testuser/Desktop/CREDENTIALS.txt \
            --wait 2>&1 || true

        # Export auth after VS Code closes
        if [ -f "/tmp/auth-profile/User/globalStorage/state.vscdb" ]; then
            cp /tmp/auth-profile/User/globalStorage/state.vscdb /workspace/clients/tracer_ext/test-results/docker-auth-profile/
            echo "✅ Auth exported successfully"
        else
            echo "⚠️ No state.vscdb found"
        fi
    '

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "Processing exported auth..."
echo "════════════════════════════════════════════════════════════════"

# Check if state.vscdb was exported
if [ -f "$AUTH_PROFILE_DIR/state.vscdb" ]; then
    echo "✅ Found exported state.vscdb"

    # Create local auth directory
    LOCAL_AUTH_DIR="$SCRIPT_DIR/../auth"
    mkdir -p "$LOCAL_AUTH_DIR"

    # Convert to base64 and save locally
    LOCAL_OUTPUT_FILE="$LOCAL_AUTH_DIR/vscode-auth-linux.b64"
    gzip -c "$AUTH_PROFILE_DIR/state.vscdb" | base64 > "$LOCAL_OUTPUT_FILE"

    echo "✅ Created local auth file: $LOCAL_OUTPUT_FILE"
    echo ""
    echo "File size: $(wc -c < "$LOCAL_OUTPUT_FILE") bytes"
    echo ""

    # Verify the export
    echo "Verifying export..."
    VERIFY_SIZE=$(base64 -d < "$LOCAL_OUTPUT_FILE" | gzip -d | wc -c)
    ORIGINAL_SIZE=$(wc -c < "$AUTH_PROFILE_DIR/state.vscdb")

    if [ "$VERIFY_SIZE" -eq "$ORIGINAL_SIZE" ]; then
        echo "✅ Export verified!"
    else
        echo "⚠️ Warning: size mismatch"
    fi

    echo ""
    echo "════════════════════════════════════════════════════════════════"
    echo "📤 Uploading to GitHub Secret"
    echo "════════════════════════════════════════════════════════════════"
    echo ""

    # Attempt to upload to GitHub secret if gh CLI is available
    if command -v gh &> /dev/null; then
        echo "🔐 Setting GitHub secret VSCODE_STATE_VSCDB_B64..."
        if gh secret set VSCODE_STATE_VSCDB_B64 --repo mobb-dev/autofixer < "$LOCAL_OUTPUT_FILE" 2>/dev/null; then
            echo "✅ GitHub secret updated successfully!"
        else
            echo "⚠️  Could not set GitHub secret (check gh auth status)"
            echo "   Manual setup: gh secret set VSCODE_STATE_VSCDB_B64 < $LOCAL_OUTPUT_FILE"
        fi
    else
        echo "💡 To upload to GitHub CI, install gh CLI and run:"
        echo "   gh secret set VSCODE_STATE_VSCDB_B64 < $LOCAL_OUTPUT_FILE"
    fi

    echo ""
    echo "════════════════════════════════════════════════════════════════"
    echo "📋 Summary:"
    echo "════════════════════════════════════════════════════════════════"
    echo ""
    echo "✅ Local auth file: $LOCAL_OUTPUT_FILE"
    echo "   (Available for local Docker testing)"
    echo ""
    echo "✅ The test will automatically use this file for local runs"
    echo "   Run: npm run test:e2e:vscode"
    echo ""
else
    echo "❌ No state.vscdb was exported"
    echo ""
    echo "Make sure you:"
    echo "  1. Connected via VNC"
    echo "  2. Signed in to GitHub in VS Code"
    echo "  3. Authenticated GitHub Copilot"
    echo "  4. Closed VS Code properly before pressing Ctrl+C"
fi

# Cleanup
rm -rf "$AUTH_PROFILE_DIR" 2>/dev/null || true
