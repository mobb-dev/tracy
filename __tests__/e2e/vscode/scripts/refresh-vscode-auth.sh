#!/bin/bash
# Export VS Code auth state for E2E testing
#
# IMPORTANT: VS Code encrypts auth tokens using the OS keychain by default.
# For portable auth (CI/Docker), we need to use --password-store=basic
# which stores tokens in plaintext in state.vscdb.
#
# This script has TWO modes:
# 1. Interactive: Create new auth profile with --password-store=basic
# 2. Export: Export existing portable auth from a basic password store profile

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_FILE="$SCRIPT_DIR/../vscode-auth.b64"
PORTABLE_PROFILE_DIR="$HOME/.vscode-e2e-portable-auth"

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║     VS Code + Copilot Auth Export for E2E Testing             ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Check if we already have a portable profile
if [ -f "$PORTABLE_PROFILE_DIR/User/globalStorage/state.vscdb" ]; then
  echo "✅ Found existing portable auth profile"
  echo "   Location: $PORTABLE_PROFILE_DIR"
  STATE_DB="$PORTABLE_PROFILE_DIR/User/globalStorage/state.vscdb"
else
  echo "📋 No portable auth profile found."
  echo ""
  echo "VS Code encrypts auth tokens with the OS keychain by default."
  echo "For CI/Docker testing, we need to create a separate profile"
  echo "that uses --password-store=basic (plaintext storage)."
  echo ""
  echo "════════════════════════════════════════════════════════════════"
  echo "STEP 1: Create Portable Auth Profile"
  echo "════════════════════════════════════════════════════════════════"
  echo ""
  echo "Run this command to open VS Code with a portable auth profile:"
  echo ""
  echo "  code --user-data-dir=\"$PORTABLE_PROFILE_DIR\" --password-store=basic"
  echo ""
  echo "Then:"
  echo "  1. Sign in to GitHub (VS Code will prompt you)"
  echo "  2. Install GitHub Copilot extension if needed"
  echo "  3. Sign in to GitHub Copilot"
  echo "  4. Close VS Code"
  echo "  5. Run this script again to export"
  echo ""
  echo "════════════════════════════════════════════════════════════════"

  read -p "Would you like to open VS Code now? [y/N] " -n 1 -r
  echo ""

  if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "🚀 Opening VS Code with portable auth profile..."
    echo "   Please sign in and authenticate Copilot, then close VS Code."

    # Create the profile directory
    mkdir -p "$PORTABLE_PROFILE_DIR"

    # Detect VS Code path
    if command -v code &> /dev/null; then
      code --user-data-dir="$PORTABLE_PROFILE_DIR" --password-store=basic --wait
    elif [ -d "/Applications/Visual Studio Code.app" ]; then
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
        --user-data-dir="$PORTABLE_PROFILE_DIR" --password-store=basic --wait
    else
      echo "❌ VS Code not found. Please install it or run the command manually."
      exit 1
    fi

    echo ""
    echo "VS Code closed. Checking for auth..."

    if [ -f "$PORTABLE_PROFILE_DIR/User/globalStorage/state.vscdb" ]; then
      STATE_DB="$PORTABLE_PROFILE_DIR/User/globalStorage/state.vscdb"
    else
      echo "❌ No state.vscdb found after VS Code session."
      echo "   Make sure you signed in and authenticated Copilot."
      exit 1
    fi
  else
    echo "Run this script again after creating the portable auth profile."
    exit 0
  fi
fi

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "STEP 2: Export Auth State"
echo "════════════════════════════════════════════════════════════════"
echo ""

echo "🔍 Checking state database..."
echo "   Path: $STATE_DB"

# Check file size
FILE_SIZE=$(wc -c < "$STATE_DB" | tr -d ' ')
echo "   Size: $FILE_SIZE bytes"

# Verify it's a SQLite database
if ! head -c 16 "$STATE_DB" | grep -q "SQLite format 3"; then
  echo "⚠️  Warning: File doesn't appear to be a SQLite database"
fi

# Check for GitHub auth keys
echo ""
echo "🔐 Checking for GitHub Copilot auth keys..."
if command -v sqlite3 &> /dev/null; then
  # Check if secrets are in plaintext (basic password store) vs encrypted (keychain)
  SECRET_CHECK=$(sqlite3 "$STATE_DB" "SELECT value FROM ItemTable WHERE key LIKE 'secret://%github%' LIMIT 1" 2>/dev/null || echo "")

  if [ -n "$SECRET_CHECK" ]; then
    # Check if it looks encrypted (starts with {"type":"Buffer") or plaintext
    if echo "$SECRET_CHECK" | grep -q '"type":"Buffer"'; then
      # Buffer format - check if it looks like encrypted data
      FIRST_BYTES=$(echo "$SECRET_CHECK" | grep -o '"data":\[.*\]' | head -c 50)
      # v10 prefix = peanuts fallback (weak but portable)
      # v11 prefix = OS keychain encrypted (NOT portable)
      if echo "$FIRST_BYTES" | grep -q '118,49,49'; then
        echo "   ⚠️  Found ENCRYPTED auth (v11 = OS keychain)"
        echo "   This auth is NOT portable and won't work in CI/Docker!"
        echo ""
        echo "   The portable profile appears to be using the OS keychain."
        echo "   This can happen if --password-store=basic wasn't used correctly."
        echo ""
        echo "   Please delete the profile and try again:"
        echo "   rm -rf \"$PORTABLE_PROFILE_DIR\""
        exit 1
      elif echo "$FIRST_BYTES" | grep -q '118,49,48'; then
        echo "   ✅ Found PORTABLE auth (v10 = basic/peanuts encryption)"
        echo "   This auth IS portable and will work in CI/Docker."
      else
        echo "   ✅ Found auth data (format unclear, assuming portable)"
      fi
    else
      echo "   ✅ Found plaintext auth data (portable)"
    fi
  else
    echo "   ⚠️  No GitHub secret keys found - auth may not work"
    echo "   Make sure you signed into GitHub and Copilot in the portable profile."
  fi

  # Show other GitHub keys
  AUTH_KEYS=$(sqlite3 "$STATE_DB" "SELECT key FROM ItemTable WHERE key LIKE '%github%' OR key LIKE '%copilot%'" 2>/dev/null || echo "")
  if [ -n "$AUTH_KEYS" ]; then
    echo ""
    echo "   Found auth-related keys:"
    echo "$AUTH_KEYS" | head -5 | while read -r key; do
      echo "   - ${key:0:60}..."
    done
  fi
else
  echo "   (sqlite3 not available, skipping key verification)"
fi

# Export with gzip compression
echo ""
echo "📦 Exporting state database..."
gzip -c "$STATE_DB" | base64 > "$OUTPUT_FILE"

EXPORT_SIZE=$(wc -c < "$OUTPUT_FILE" | tr -d ' ')
echo "✅ Exported to: $OUTPUT_FILE"
echo "   Compressed size: $EXPORT_SIZE chars (base64)"

# Verify the export
echo ""
echo "🔍 Verifying export..."
VERIFY_SIZE=$(base64 -d < "$OUTPUT_FILE" | gzip -d | wc -c | tr -d ' ')
if [ "$VERIFY_SIZE" -eq "$FILE_SIZE" ]; then
  echo "✅ Export verified successfully!"
else
  echo "⚠️  Warning: Verification mismatch (original: $FILE_SIZE, decoded: $VERIFY_SIZE)"
fi

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "📋 Next Steps"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "1. For LOCAL testing:"
echo "   npm run test:e2e:vscode:docker"
echo "   (The vscode-auth.b64 file will be used automatically)"
echo ""
echo "2. For CI testing:"
echo "   Add the contents as a GitHub secret:"
echo "   - Secret name: VSCODE_STATE_VSCDB_B64"
echo "   - URL: https://github.com/mobb-dev/autofixer/settings/secrets/actions"
echo "   - Copy contents of: $OUTPUT_FILE"
echo ""
echo "⚠️  IMPORTANT: Auth tokens expire! Run this script again if tests"
echo "   start failing with auth errors."
echo ""
echo "🔒 Security note: The exported file contains your GitHub auth tokens"
echo "   in a weakly encrypted format. Do not commit it to version control."
echo "   It is gitignored by default."
