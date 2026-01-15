FROM mcr.microsoft.com/playwright:v1.56.1-jammy

# Set environment variables early
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

# Install additional dependencies for Cursor/VS Code
RUN apt-get update && apt-get install -y \
    xvfb \
    x11vnc \
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
    && rm -rf /var/lib/apt/lists/*

# Set display environment variable
ENV DISPLAY=:99

# Install Node.js 22 (matching your project requirement)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g npm@latest pnpm

# Download and install Cursor AppImage
# Note: This downloads the latest version. Pin to a specific version for reproducibility.
# Detect architecture and download the correct version (x64 for CI, arm64 for ARM)
RUN cd /tmp && \
    ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then \
      CURSOR_ARCH="linux-x64"; \
    elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then \
      CURSOR_ARCH="linux-arm64"; \
    else \
      echo "Unsupported architecture: $ARCH" && exit 1; \
    fi && \
    echo "Downloading Cursor for $CURSOR_ARCH (detected: $ARCH)" && \
    wget -O cursor.AppImage "https://api2.cursor.sh/updates/download/golden/${CURSOR_ARCH}/cursor/2.0" && \
    chmod +x cursor.AppImage && \
    ./cursor.AppImage --appimage-extract && \
    mv squashfs-root /opt/cursor && \
    ln -s /opt/cursor/AppRun /usr/local/bin/cursor && \
    rm cursor.AppImage

# Set CURSOR_PATH env var for the test
ENV CURSOR_PATH=/opt/cursor/AppRun

# Use shorter temp dir path to avoid IPC socket path length issues (must be < 103 chars)
ENV TEST_TEMP_DIR=/tmp/e2e

# Create a non-root user to run tests (Cursor/VS Code doesn't like running as root)
RUN groupadd -r testuser && useradd -r -g testuser -d /home/testuser -m testuser
RUN mkdir -p /tmp/e2e /home/testuser/.config && \
    chown -R testuser:testuser /tmp/e2e /home/testuser

# Alternative: Install VS Code if Cursor is not available
# RUN wget -qO- https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor > packages.microsoft.gpg && \
#     install -D -o root -g root -m 644 packages.microsoft.gpg /etc/apt/keyrings/packages.microsoft.gpg && \
#     sh -c 'echo "deb [arch=amd64,arm64,armhf signed-by=/etc/apt/keyrings/packages.microsoft.gpg] https://packages.microsoft.com/repos/code stable main" > /etc/apt/sources.list.d/vscode.list' && \
#     apt-get update && \
#     apt-get install -y code

# Create workspace directory (monorepo root)
WORKDIR /workspace

# Copy monorepo workspace files first for better caching
COPY pnpm-lock.yaml ./
COPY pnpm-workspace.yaml ./
COPY package.json ./

# Set working directory to cursor extension
WORKDIR /workspace/clients/tracer_ext

# Copy the pre-built VSIX and test files
# Note: COPY with wildcards fails if no files match, so we copy the directory contents
# The CI workflow builds the VSIX before docker build
COPY clients/tracer_ext/__tests__ ./__tests__
COPY clients/tracer_ext/package.json ./package.json
COPY clients/tracer_ext/package-lock.json ./package-lock.json

# Copy VSIX files (built by CI before docker build)
# Using a shell to handle the glob pattern more reliably
COPY clients/tracer_ext/mobb-ai-tracer*.vsix ./

# Verify VSIX was copied
RUN echo "📦 VSIX files after COPY:" && ls -la *.vsix || (echo "❌ ERROR: No VSIX files found! Build the extension first." && exit 1)

# Install test dependencies
# Use npm instead of pnpm to avoid native module build approval issues
# pnpm v10+ blocks build scripts by default which breaks @vscode/sqlite3 and better-sqlite3
RUN npm ci || npm install

# Extract the VSIX to a staging area and rebuild native modules for Linux
# This is needed because the VSIX was built on macOS with macOS-native binaries
# Use the non-dev VSIX (smaller, production build)
RUN mkdir -p /tmp/vsix-staging && \
    VSIX_FILE=$(ls mobb-ai-tracer-[0-9]*.vsix | head -1) && \
    echo "Extracting: $VSIX_FILE" && \
    unzip -q "$VSIX_FILE" -d /tmp/vsix-staging && \
    cd /tmp/vsix-staging/extension && \
    npm install @vscode/sqlite3 --build-from-source && \
    echo "✅ Native module rebuilt for Linux"

# Repackage the VSIX with Linux-native modules
RUN cd /tmp/vsix-staging && \
    zip -r /workspace/clients/tracer_ext/mobb-ai-tracer-linux.vsix . && \
    echo "✅ VSIX repackaged with Linux-native modules"

# Verify VSIX was created
RUN ls -lh *.vsix && echo "✓ VSIX files ready for testing"

# Set ownership for the workspace so non-root user can write test results
RUN chown -R testuser:testuser /workspace

# Create a script to run tests with Xvfb
# Note: The playwright-automation.test.ts starts its own mock server on port 3000
RUN echo '#!/bin/bash\n\
set -e\n\
\n\
echo "================================="\n\
echo "Starting Cursor Extension E2E Test"\n\
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
npx playwright test __tests__/e2e/cursor/playwright-automation.test.ts || TEST_EXIT_CODE=$?\n\
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

# Copy entrypoint script that handles runtime VSIX mounting
COPY clients/tracer_ext/__tests__/e2e/cursor/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Switch to non-root user before running tests
USER testuser
ENV HOME=/home/testuser

# Set entrypoint (runs before CMD, handles VSIX mounting)
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Set the default command (executed by entrypoint)
CMD ["/usr/local/bin/run-e2e-tests.sh"]

# Expose VNC port for debugging (optional)
EXPOSE 5900
