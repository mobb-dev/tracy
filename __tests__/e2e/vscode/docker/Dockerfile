FROM mcr.microsoft.com/playwright:v1.56.1-jammy

# Set environment variables early
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

# Install additional dependencies for VS Code
RUN apt-get update && apt-get install -y \
    xvfb \
    x11vnc \
    xdotool \
    imagemagick \
    wmctrl \
    libgtk-3-0 \
    libgbm1 \
    libasound2 \
    libxss1 \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    curl \
    wget \
    git \
    unzip \
    zip \
    build-essential \
    python3 \
    gnupg \
    apt-transport-https \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI (gh) for authentication
# VS Code Copilot can detect gh CLI authentication
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && \
    apt-get install -y gh && \
    rm -rf /var/lib/apt/lists/*

# Set display environment variable
ENV DISPLAY=:99

# Install Node.js 22 (matching your project requirement)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g pnpm

# Download and install VS Code - ALWAYS GET LATEST STABLE VERSION
# Using Microsoft package repository to auto-select correct architecture and get latest version
RUN wget -qO- https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor > packages.microsoft.gpg && \
    install -D -o root -g root -m 644 packages.microsoft.gpg /etc/apt/keyrings/packages.microsoft.gpg && \
    echo "deb [arch=amd64,arm64 signed-by=/etc/apt/keyrings/packages.microsoft.gpg] https://packages.microsoft.com/repos/code stable main" > /etc/apt/sources.list.d/vscode.list && \
    apt-get update && \
    apt-get install -y code && \
    rm -rf /var/lib/apt/lists/* && \
    echo "✅ VS Code version installed:" && \
    code --no-sandbox --user-data-dir=/tmp/vscode-root-check --version

# Set VSCODE_PATH env var for the test
ENV VSCODE_PATH=/usr/share/code/code

# Install Firefox browser for OAuth flow during manual auth creation
# Ubuntu 22.04 moved Chromium to snap-only, which doesn't work in Docker
# Firefox is available via Mozilla's PPA as a traditional deb package
# Also install:
# - openbox: window manager for VNC
# - gnome-keyring: provides keychain service for VS Code SecretStorage
# - dbus-x11: D-Bus integration for X11 (needed by gnome-keyring)
# - libsecret-1-0: SecretStorage backend library
# - libsecret-tools: provides secret-tool command for storing secrets in keyring
RUN apt-get update && \
    apt-get install -y software-properties-common openbox \
        gnome-keyring libsecret-1-0 libsecret-tools dbus-x11 && \
    add-apt-repository -y ppa:mozillateam/ppa && \
    apt-get update && \
    apt-get install -y firefox-esr && \
    rm -rf /var/lib/apt/lists/*

# Pre-install GitHub Copilot extensions to a shared location during Docker build.
#
# We DO NOT use `code --install-extension` because recent VS Code versions ship
# `GitHub.copilot-chat` as a built-in, causing `code --install-extension` to:
#   1. Fail copilot-chat ("built-in extension cannot be downgraded")
#   2. Silently roll back GitHub.copilot (its extensionPack depends on chat)
#   3. Still exit 0, leaving /opt/copilot-extensions empty and breaking tests.
#
# Instead we:
#   1. Download the main Copilot VSIX directly from the marketplace and extract
#      it (skips VS Code's dep resolution entirely).
#   2. Copy the Copilot Chat built-in from the VS Code install directory to the
#      canonical `github.copilot-chat-<version>` location the tests look for.
#   3. Hard-validate both extensions are present — fail the build loudly rather
#      than silently produce a stale image.
RUN set -eux && \
    mkdir -p /opt/copilot-extensions && \
    echo "📦 Downloading GitHub Copilot VSIX from marketplace..." && \
    curl -fsSL --compressed \
      "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/GitHub/vsextensions/copilot/latest/vspackage" \
      -o /tmp/github.copilot.vsix && \
    COPILOT_VER=$(unzip -p /tmp/github.copilot.vsix extension/package.json | \
      python3 -c "import sys,json; print(json.load(sys.stdin)['version'])") && \
    echo "📦 Extracting GitHub.copilot v${COPILOT_VER}..." && \
    mkdir -p /tmp/copilot-unzip && \
    unzip -q /tmp/github.copilot.vsix -d /tmp/copilot-unzip && \
    mv /tmp/copilot-unzip/extension \
       "/opt/copilot-extensions/github.copilot-${COPILOT_VER}" && \
    rm -rf /tmp/copilot-unzip /tmp/github.copilot.vsix && \
    echo "📦 Copying built-in GitHub.copilot-chat from VS Code install..." && \
    CHAT_SRC=/usr/share/code/resources/app/extensions/copilot && \
    CHAT_VER=$(python3 -c "import json; print(json.load(open('${CHAT_SRC}/package.json'))['version'])") && \
    cp -r "${CHAT_SRC}" "/opt/copilot-extensions/github.copilot-chat-${CHAT_VER}" && \
    chmod -R 755 /opt/copilot-extensions && \
    echo "🔎 Validating Copilot extensions were installed..." && \
    python3 -c "\
import json, glob, sys;\
required = {'GitHub.copilot', 'GitHub.copilot-chat'};\
found = {};\
[found.setdefault(f\"{json.load(open(d+'/package.json'))['publisher']}.{json.load(open(d+'/package.json'))['name']}\", d) for d in glob.glob('/opt/copilot-extensions/*') if __import__('os').path.isfile(d+'/package.json')];\
missing = required - set(found);\
sys.exit(f'❌ Missing extensions: {missing}. Found: {sorted(found)}') if missing else print(f'✅ All required extensions installed: {sorted(found)}')" && \
    echo "📋 Final /opt/copilot-extensions listing:" && \
    ls -la /opt/copilot-extensions/

# Use shorter temp dir path to avoid IPC socket path length issues (must be < 103 chars)
ENV TEST_TEMP_DIR=/tmp/e2e

# Keep the testuser for potential future use, but we'll run as root for now
# Create a non-root user (keeping for backwards compatibility, but not used)
RUN groupadd -r testuser && useradd -r -g testuser -d /home/testuser -m testuser
RUN mkdir -p /tmp/e2e /home/testuser/.config && \
    chown -R testuser:testuser /tmp/e2e /home/testuser

# Create workspace directory (monorepo root)
WORKDIR /workspace

# Copy monorepo workspace files first for better caching
COPY pnpm-lock.yaml ./
COPY pnpm-workspace.yaml ./
COPY package.json ./

# Set working directory to tracer extension
WORKDIR /workspace/clients/tracer_ext

# Copy the pre-built VSIX and test files
# Note: COPY with wildcards fails if no files match, so we copy the directory contents
# The CI workflow builds the VSIX before docker build
COPY clients/tracer_ext/__tests__ ./__tests__
COPY clients/tracer_ext/package.json ./package.json
COPY clients/tracer_ext/package-lock.json ./package-lock.json

# Copy VSIX files (built by CI before docker build)
# Using a shell to handle the glob pattern more reliably
# NOTE: For local development, VSIX can be mounted at runtime instead of bundled in image
COPY clients/tracer_ext/mobb-ai-tracer*.vsix ./

# Verify VSIX was copied
RUN echo "📦 VSIX files after COPY:" && ls -la *.vsix || (echo "❌ ERROR: No VSIX files found! Build the extension first." && exit 1)

# Install test dependencies
# Use npm instead of pnpm to avoid native module build approval issues
# pnpm v10+ blocks build scripts by default which breaks @vscode/sqlite3 and better-sqlite3
RUN npm ci || npm install

# No native module repackaging needed — esbuild bundles everything into the VSIX.
# The extension uses node:sqlite (Node.js built-in), not @vscode/sqlite3.

# Verify VSIX was created
RUN ls -lh *.vsix && echo "✓ VSIX files ready for testing"

# No need to change ownership when running as root
# RUN chown -R testuser:testuser /workspace (removed - running as root)

# Create a script to run tests with Xvfb
# Note: The playwright-automation.test.ts starts its own mock server on port 3000
RUN echo '#!/bin/bash\n\
set -e\n\
\n\
echo "================================="\n\
echo "Starting VS Code Extension E2E Test"\n\
echo "================================="\n\
\n\
# Ensure test-results directory exists and is writable\n\
# This handles the case where volume mount creates a root-owned directory\n\
RESULTS_DIR="/workspace/clients/tracer_ext/test-results"\n\
if [ ! -w "$RESULTS_DIR" ]; then\n\
  echo "⚠️  test-results directory not writable, will use /tmp/test-results"\n\
  mkdir -p /tmp/test-results\n\
  rm -rf "$RESULTS_DIR" 2>/dev/null || true\n\
  ln -sf /tmp/test-results "$RESULTS_DIR" 2>/dev/null || true\n\
fi\n\
mkdir -p "$RESULTS_DIR" 2>/dev/null || true\n\
\n\
# Start D-Bus session bus (required for gnome-keyring)\n\
echo "Starting D-Bus session bus..."\n\
eval $(dbus-launch --sh-syntax)\n\
export DBUS_SESSION_BUS_ADDRESS\n\
echo "D-Bus session: $DBUS_SESSION_BUS_ADDRESS"\n\
\n\
# Initialize gnome-keyring with improved setup for headless environment\n\
# This provides a keychain service for VS Code SecretStorage\n\
echo "Initializing gnome-keyring..."\n\
# Step 1: Start the daemon (creates default keyring if needed)\n\
eval $(gnome-keyring-daemon --start --components=secrets 2>/dev/null)\n\
export GNOME_KEYRING_CONTROL\n\
export SSH_AUTH_SOCK\n\
echo "Keyring control: ${GNOME_KEYRING_CONTROL:-not set}"\n\
\n\
# Step 2: Unlock with empty password using printf (more reliable than echo)\n\
printf '\''\\n'\'' | gnome-keyring-daemon --unlock 2>/dev/null || true\n\
\n\
# Set password store to gnome-libsecret (now that keyring is available)\n\
export PASSWORD_STORE_KEY="gnome-libsecret"\n\
\n\
# Keyring test removed - not needed with VSCODE_STATE_VSCDB_B64 pre-built auth\n\
\n\
# Start Xvfb\n\
echo "Starting Xvfb..."\n\
Xvfb :99 -screen 0 1920x1080x24 &\n\
XVFB_PID=$!\n\
echo "Xvfb started with PID: $XVFB_PID"\n\
sleep 2\n\
\n\
# Optional: Start VNC for debugging\n\
if [ "$ENABLE_VNC" = "true" ]; then\n\
  echo "Starting VNC server..."\n\
  x11vnc -display :99 -forever -nopw -quiet -bg\n\
  echo "VNC server started on port 5900"\n\
fi\n\
\n\
echo "Xvfb ready. Starting tests..."\n\
echo "(Mock server will be started by the test itself on port 3000)"\n\
echo ""\n\
\n\
# Run tests\n\
cd /workspace/clients/tracer_ext\n\
npx playwright test __tests__/e2e/vscode/playwright-automation.test.ts || TEST_EXIT_CODE=$?\n\
\n\
# Copy results from /tmp if we used the symlink workaround\n\
if [ -L "$RESULTS_DIR" ] && [ -d /tmp/test-results ]; then\n\
  echo "Copying test results..."\n\
  rm "$RESULTS_DIR"\n\
  mkdir -p "$RESULTS_DIR"\n\
  cp -r /tmp/test-results/* "$RESULTS_DIR/" 2>/dev/null || true\n\
fi\n\
\n\
# Cleanup\n\
echo ""\n\
echo "Cleaning up..."\n\
kill $XVFB_PID 2>/dev/null || true\n\
\n\
# Show final status\n\
if [ "${TEST_EXIT_CODE:-0}" -eq 0 ]; then\n\
  echo ""\n\
  echo "================================"\n\
  echo "✅ E2E Tests PASSED"\n\
  echo "================================"\n\
else\n\
  echo ""\n\
  echo "================================"\n\
  echo "❌ E2E Tests FAILED"\n\
  echo "================================"\n\
fi\n\
\n\
exit ${TEST_EXIT_CODE:-0}\n\
' > /usr/local/bin/run-e2e-tests.sh && \
    chmod +x /usr/local/bin/run-e2e-tests.sh

# Run everything as root to avoid permission issues
# USER testuser (removed - running as root)
# ENV HOME=/home/testuser (removed - using root home)

# Copy entrypoint script that handles runtime VSIX mounting
COPY clients/tracer_ext/__tests__/e2e/vscode/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Set entrypoint (runs before CMD, handles VSIX mounting)
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Set the default command (executed by entrypoint)
CMD ["/usr/local/bin/run-e2e-tests.sh"]

# Expose VNC port for debugging (optional)
EXPOSE 5900
