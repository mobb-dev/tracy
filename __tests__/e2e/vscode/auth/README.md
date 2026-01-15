# VS Code Auth Files

This directory contains authentication credentials for VS Code E2E tests.

## Files

- `vscode-auth-linux.b64` - Linux-native GitHub + Copilot authentication (created by `scripts/create-docker-auth.sh`)

## Purpose

These auth files are used for **local Docker testing**. They allow you to:

1. Run E2E tests locally without setting up Device Flow OAuth
2. Test the same auth that will be used in CI
3. Verify auth credentials before uploading to GitHub secrets

## Creating Auth Files

Run the auth creation script:

```bash
cd ../scripts
./create-docker-auth.sh
```

This will:
1. Build a Docker container with VS Code
2. Start a VNC server on port 5900
3. Allow you to authenticate manually via VNC
4. Export the Linux-native auth to this directory
5. Automatically upload to GitHub secret `VSCODE_STATE_VSCDB_B64`

## Security

⚠️ **DO NOT COMMIT THESE FILES**

- Auth files contain OAuth tokens and are **gitignored**
- They should only exist locally and as GitHub secrets
- Tokens may expire and need to be refreshed periodically

## Test Priority

The test will use auth in this order:

1. `VSCODE_STATE_VSCDB_B64` env var (CI)
2. `VSCODE_AUTH_DIR` env var
3. **This directory** (local)
4. Local VS Code installation
5. Device Flow OAuth (fallback)

## Troubleshooting

If tests fail with auth errors:

1. Check if auth file exists: `ls -la`
2. Re-run `create-docker-auth.sh` to generate fresh auth
3. Verify the file is not empty: `wc -c vscode-auth-linux.b64`
