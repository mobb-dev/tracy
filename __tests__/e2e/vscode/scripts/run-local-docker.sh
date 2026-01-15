#!/bin/bash
#
# Run VS Code E2E tests locally with Device Flow authentication
#
# Usage:
#   ./run-local-docker.sh
#
# Required Environment Variables:
#   PLAYWRIGHT_GH_CLOUD_USER_EMAIL    - GitHub account email
#   PLAYWRIGHT_GH_CLOUD_USER_PASSWORD - GitHub account password
#
# Optional Environment Variables:
#   ENABLE_VNC=true                   - Enable VNC server on port 5900 for debugging
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRACER_EXT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REPO_ROOT="$(cd "$TRACER_EXT_DIR/../.." && pwd)"

# Check for required credentials
if [ -z "$PLAYWRIGHT_GH_CLOUD_USER_EMAIL" ] || [ -z "$PLAYWRIGHT_GH_CLOUD_USER_PASSWORD" ]; then
    echo "❌ Error: Missing required credentials"
    echo ""
    echo "Please set the following environment variables:"
    echo "  export PLAYWRIGHT_GH_CLOUD_USER_EMAIL='your-github-email@example.com'"
    echo "  export PLAYWRIGHT_GH_CLOUD_USER_PASSWORD='your-github-password'"
    echo ""
    echo "Or create a file at clients/tracer_ext/__tests__/.env with:"
    echo "  PLAYWRIGHT_GH_CLOUD_USER_EMAIL=your-github-email@example.com"
    echo "  PLAYWRIGHT_GH_CLOUD_USER_PASSWORD=your-github-password"
    echo ""
    echo "To run without Copilot tests (checkpoints 1-4 only):"
    echo "  docker run --rm tracer-ext-vscode-e2e"
    exit 1
fi

echo "🔧 Building extension..."
cd "$TRACER_EXT_DIR"
npm run build
npm run package:test

echo "🐳 Building Docker image..."
cd "$REPO_ROOT"
docker build -t tracer-ext-vscode-e2e -f clients/tracer_ext/__tests__/e2e/vscode/docker/Dockerfile .

echo "🚀 Running E2E tests..."
echo "   Email: $PLAYWRIGHT_GH_CLOUD_USER_EMAIL"
echo ""

# Run Docker with credentials as env vars
docker run --rm \
    -e "PLAYWRIGHT_GH_CLOUD_USER_EMAIL=$PLAYWRIGHT_GH_CLOUD_USER_EMAIL" \
    -e "PLAYWRIGHT_GH_CLOUD_USER_PASSWORD=$PLAYWRIGHT_GH_CLOUD_USER_PASSWORD" \
    -e "ENABLE_VNC=${ENABLE_VNC:-false}" \
    -p 8080:8080 \
    -p 5173:5173 \
    -p 5900:5900 \
    -v "$TRACER_EXT_DIR/test-results:/workspace/clients/tracer_ext/test-results" \
    tracer-ext-vscode-e2e
