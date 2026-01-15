#!/bin/bash
#
# Run E2E tests in Docker container with proper environment setup
#
# Usage: ./run-docker-test.sh <image-tag> <ide-name> <requires-auth>
#
# Environment variables:
#   - AWS_BEARER_TOKEN_BEDROCK: AWS bearer token for Bedrock
#   - AWS_ACCESS_KEY_ID: AWS access key
#   - AWS_SECRET_ACCESS_KEY: AWS secret key
#   - AWS_REGION: AWS region (for Claude Code auth)
#   - AWS_DEFAULT_REGION: AWS default region
#   - ANTHROPIC_API_KEY: Anthropic API key
#   - CURSOR_STATE_VSCDB_B64: Base64-encoded Cursor auth database
#   - VSCODE_STATE_VSCDB_B64: Base64-encoded VS Code auth database
#   - DEBUG: Enable debug mode
#   - CLAUDE_CODE_USE_BEDROCK: Use Bedrock for Claude Code
#   - DEBUG_MODE_INPUT: Enable debug mode (alternative to DEBUG)

set -e

# Validate arguments
if [ $# -lt 3 ]; then
  echo "Usage: $0 <image-tag> <ide-name> <requires-auth>"
  echo "Example: $0 cursor-e2e:latest Cursor true"
  exit 1
fi

IMAGE_TAG="$1"
IDE_NAME="$2"
REQUIRES_AUTH="$3"
DEBUG_MODE_INPUT="${DEBUG_MODE_INPUT:-false}"

echo "==============================================="
echo "STARTING $IDE_NAME E2E TESTS IN DOCKER"
echo "==============================================="

# Create test results directory with proper permissions
mkdir -p clients/tracer_ext/test-results
chmod 777 clients/tracer_ext/test-results

# Build Docker environment arguments
DOCKER_ENV_ARGS="-e CI=true"

# Add auth env vars if required
if [ "$REQUIRES_AUTH" == "true" ]; then
  if [ -n "$AWS_BEARER_TOKEN_BEDROCK" ]; then
    DOCKER_ENV_ARGS="$DOCKER_ENV_ARGS -e AWS_BEARER_TOKEN_BEDROCK -e AWS_REGION -e CLAUDE_CODE_USE_BEDROCK"
  elif [ -n "$AWS_ACCESS_KEY_ID" ] && [ -n "$AWS_SECRET_ACCESS_KEY" ]; then
    DOCKER_ENV_ARGS="$DOCKER_ENV_ARGS -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION"
  fi

  if [ -n "$ANTHROPIC_API_KEY" ]; then
    DOCKER_ENV_ARGS="$DOCKER_ENV_ARGS -e ANTHROPIC_API_KEY"
  fi
fi

# Add Cursor auth if available
if [ -n "$CURSOR_STATE_VSCDB_B64" ]; then
  DOCKER_ENV_ARGS="$DOCKER_ENV_ARGS -e CURSOR_STATE_VSCDB_B64"
fi

# Add VS Code auth if available
if [ -n "$VSCODE_STATE_VSCDB_B64" ]; then
  DOCKER_ENV_ARGS="$DOCKER_ENV_ARGS -e VSCODE_STATE_VSCDB_B64"
fi

# Add debug mode if enabled
if [ "$DEBUG_MODE_INPUT" == "true" ]; then
  DOCKER_ENV_ARGS="$DOCKER_ENV_ARGS -e DEBUG=true"
fi

# Start timing
TEST_START=$(date +%s)

# Run Docker container with test
# Note: Using tee with PIPESTATUS to capture both output and exit code
docker run --rm \
  --memory=2g \
  --memory-swap=2g \
  $DOCKER_ENV_ARGS \
  -v "$(pwd)/clients/tracer_ext/test-results:/workspace/clients/tracer_ext/test-results" \
  "$IMAGE_TAG" 2>&1 | tee "/tmp/docker-run-$IMAGE_TAG.log"

# Capture test exit code (from docker run, not tee)
TEST_EXIT_CODE=${PIPESTATUS[0]}
TEST_END=$(date +%s)
TEST_DURATION=$((TEST_END - TEST_START))

# Print test summary
echo ""
echo "==============================================="
echo "TEST SUMMARY"
echo "==============================================="
if [ "$TEST_EXIT_CODE" -eq 0 ]; then
  echo "✅ RESULT: PASSED"
else
  echo "❌ RESULT: FAILED"
fi
echo "Duration: ${TEST_DURATION}s"
echo "Exit code: $TEST_EXIT_CODE"

# Write outputs for GitHub Actions
if [ -n "$GITHUB_OUTPUT" ]; then
  echo "test_exit_code=$TEST_EXIT_CODE" >> "$GITHUB_OUTPUT"
  echo "test_duration=$TEST_DURATION" >> "$GITHUB_OUTPUT"
fi

# Exit with the same code as the test
exit "$TEST_EXIT_CODE"
