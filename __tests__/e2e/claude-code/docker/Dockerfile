# Use Node.js base image (no need for Playwright since Claude Code is CLI-based)
FROM node:22-bookworm

# Set environment variables
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

# Install additional dependencies
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    git \
    build-essential \
    python3 \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
# Claude Code is the official Anthropic CLI for Claude
RUN npm install -g @anthropic-ai/claude-code

# Verify Claude Code installation
RUN claude --version || echo "Claude Code installed"

# Use shorter temp dir path
ENV TEST_TEMP_DIR=/tmp/e2e

# Create a non-root user to run tests
RUN groupadd -r testuser && useradd -r -g testuser -d /home/testuser -m testuser
RUN mkdir -p /tmp/e2e /home/testuser/.claude && \
    chown -R testuser:testuser /tmp/e2e /home/testuser

# Create workspace directory (monorepo root)
WORKDIR /workspace

# Copy monorepo workspace files for dependency installation
COPY pnpm-lock.yaml ./
COPY pnpm-workspace.yaml ./
COPY package.json ./

# Install pnpm
RUN npm install -g pnpm@10

# Copy the CLI package for mobbdev hook installation
COPY clients/cli ./clients/cli

# Copy tracer_ext test files
COPY clients/tracer_ext/__tests__ ./clients/tracer_ext/__tests__
COPY clients/tracer_ext/package.json ./clients/tracer_ext/package.json

# Set working directory to tracer extension for tests
WORKDIR /workspace/clients/tracer_ext

# Install test dependencies
RUN npm install

# Build mobbdev CLI (needed for hook installation)
WORKDIR /workspace/clients/cli
RUN pnpm install && pnpm run build

# Link mobbdev globally so it can be used by tests
RUN npm link

# Go back to tracer_ext for tests
WORKDIR /workspace/clients/tracer_ext

# Set ownership for the workspace
RUN chown -R testuser:testuser /workspace

# Create test runner script
RUN echo '#!/bin/bash\n\
set -e\n\
\n\
echo "================================="\n\
echo "Starting Claude Code Extension E2E Test"\n\
echo "================================="\n\
\n\
# Ensure test-results directory exists\n\
RESULTS_DIR="/workspace/clients/tracer_ext/test-results"\n\
mkdir -p "$RESULTS_DIR" 2>/dev/null || true\n\
\n\
echo "Claude Code version:"\n\
claude --version || echo "Could not get version"\n\
echo ""\n\
\n\
echo "Mobbdev CLI:"\n\
mobbdev --version || echo "Could not get version"\n\
echo ""\n\
\n\
echo "Starting tests..."\n\
cd /workspace/clients/tracer_ext\n\
npx vitest run __tests__/e2e/claude-code/claude-code-e2e.test.ts || TEST_EXIT_CODE=$?\n\
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

# Switch to non-root user
USER testuser
ENV HOME=/home/testuser

# Set the default command
CMD ["/usr/local/bin/run-e2e-tests.sh"]
