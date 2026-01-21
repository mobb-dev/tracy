# Claude Code E2E Tests

End-to-end tests for validating the Mobb AI attribution capture flow with Claude Code.

## Overview

This test suite validates the complete flow:
1. **Install Claude Code** - The official Anthropic CLI
2. **Configure AWS Bedrock** - For Claude model access
3. **Install Mobb Hook** - PostToolUse hook in Claude Code settings
4. **Run Claude Code** - Generate code with a prompt
5. **Capture Attribution** - Hook captures code generation metadata
6. **Upload Attribution** - Metadata sent to mock server

## Prerequisites

### AWS Bedrock Credentials
Claude Code uses AWS Bedrock for model access. You need:
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_DEFAULT_REGION` (default: us-west-2)

Alternatively, you can use `ANTHROPIC_API_KEY` for direct API access.

## Running Tests

### Local Testing
```bash
# From tracer_ext directory
cd clients/tracer_ext

# Run the test directly
npx ts-node __tests__/e2e/claude-code/claude-code-e2e.test.ts
```

### Docker Testing
```bash
# Build the Docker image
docker build \
  -f clients/tracer_ext/__tests__/e2e/claude-code/docker/Dockerfile \
  -t claude-code-e2e \
  .

# Run tests in Docker
docker run --rm \
  -e AWS_ACCESS_KEY_ID="your-key" \
  -e AWS_SECRET_ACCESS_KEY="your-secret" \
  -e AWS_DEFAULT_REGION="us-west-2" \
  claude-code-e2e
```

## CI/CD

The workflow runs automatically on:
- Push to `main` affecting `clients/cli/**` or the workflow file
- Pull requests to `main`

### Required Secrets
Configure these in your GitHub repository secrets:
- `AWS_ACCESS_KEY_ID` - AWS access key with Bedrock permissions
- `AWS_SECRET_ACCESS_KEY` - AWS secret key
- `AWS_DEFAULT_REGION` - (Optional) AWS region, defaults to us-west-2
- `ANTHROPIC_API_KEY` - (Optional) Direct Anthropic API key fallback

## Test Checkpoints

| Checkpoint | Description |
|------------|-------------|
| Claude Code Installed | CLI is available in PATH |
| AWS Bedrock Configured | Credentials are set |
| Mobb Hook Installed | PostToolUse hook configured |
| Mock Server Running | Attribution capture server started |
| Claude Code Prompt Sent | Prompt submitted to Claude |
| Code Generated | File created successfully |
| Hook Captured Attribution | Hook executed and captured data |
| Attribution Uploaded | Data sent to mock server |

## Troubleshooting

### "Claude Code not found"
Install Claude Code globally:
```bash
npm install -g @anthropic-ai/claude-code
```

### "No API credentials found"
Set AWS credentials:
```bash
export AWS_ACCESS_KEY_ID="your-key"
export AWS_SECRET_ACCESS_KEY="your-secret"
```

### "Attribution upload timeout"
- Check that the hook is properly installed in `~/.claude/settings.json`
- Verify the mock server is running on port 3000
- Check hook output logs in test-results directory

## Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────┐
│   Claude Code   │────▶│  Mobb Hook   │────▶│ Mock Server │
│    (AI Gen)     │     │ (PostToolUse)│     │   (3000)    │
└─────────────────┘     └──────────────┘     └─────────────┘
        │                       │                    │
        ▼                       ▼                    ▼
   Edit/Write              Captures             Validates
   tool calls              inference            attribution
```
