#!/bin/bash
#
# Refresh Cursor Auth for E2E Tests
#
# This script extracts only the authentication keys from your local Cursor
# database and creates a minimal state.vscdb for E2E testing.
#
# Usage: npm run e2e:refresh-auth
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_FILE="$E2E_DIR/cursor-auth.b64"
TEMP_DB="/tmp/cursor-auth-minimal.vscdb"

# Detect OS and set Cursor path
case "$(uname -s)" in
    Darwin)
        CURSOR_DB="$HOME/Library/Application Support/Cursor/User/globalStorage/state.vscdb"
        ;;
    Linux)
        if [ -f "$HOME/.config/Cursor/User/globalStorage/state.vscdb" ]; then
            CURSOR_DB="$HOME/.config/Cursor/User/globalStorage/state.vscdb"
        elif [ -f "$HOME/.config/cursor/User/globalStorage/state.vscdb" ]; then
            CURSOR_DB="$HOME/.config/cursor/User/globalStorage/state.vscdb"
        else
            echo "❌ Cursor state.vscdb not found on Linux"
            exit 1
        fi
        ;;
    *)
        echo "❌ Unsupported OS: $(uname -s)"
        exit 1
        ;;
esac

# Check if Cursor is installed and logged in
if [ ! -f "$CURSOR_DB" ]; then
    echo "❌ Cursor auth not found at: $CURSOR_DB"
    echo "   Make sure Cursor is installed and you're logged in"
    exit 1
fi

# Check if sqlite3 is available
if ! command -v sqlite3 &> /dev/null; then
    echo "❌ sqlite3 is required but not installed"
    exit 1
fi

# Check for auth tokens
AUTH_COUNT=$(sqlite3 "$CURSOR_DB" "SELECT COUNT(*) FROM ItemTable WHERE key LIKE 'cursorAuth/%';" 2>/dev/null || echo "0")
if [ "$AUTH_COUNT" -eq 0 ]; then
    echo "❌ No Cursor auth tokens found"
    echo "   Please log in to Cursor first"
    exit 1
fi

echo "📤 Extracting Cursor auth and onboarding state..."
echo "   Source: $CURSOR_DB"
echo "   Found $AUTH_COUNT auth entries"

# Create minimal database with auth + onboarding keys
rm -f "$TEMP_DB"

sqlite3 "$TEMP_DB" "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);"

# Keys to extract:
# - cursorAuth/* : Auth tokens
# - cursor.* : Feature flags
# - cursor/* : Agent layout, settings
# - cursorai/* : Privacy mode, feature config
# - workbench.contrib.onboarding.* : Onboarding completion flags
KEYS_QUERY="SELECT key, value FROM ItemTable WHERE
    key LIKE 'cursorAuth/%' OR
    key LIKE 'cursor.%' OR
    key LIKE 'cursor/%' OR
    key LIKE 'cursorai/%' OR
    key LIKE 'workbench.contrib.onboarding.%';"

sqlite3 "$CURSOR_DB" "$KEYS_QUERY" | while IFS='|' read -r key value; do
    # Escape single quotes in value
    escaped_value=$(echo "$value" | sed "s/'/''/g")
    sqlite3 "$TEMP_DB" "INSERT INTO ItemTable (key, value) VALUES ('$key', '$escaped_value');"
done

# Verify the minimal DB
MINIMAL_COUNT=$(sqlite3 "$TEMP_DB" "SELECT COUNT(*) FROM ItemTable;")
echo "   Extracted $MINIMAL_COUNT keys to minimal database"

# Show what was extracted
echo "   Key categories:"
sqlite3 "$TEMP_DB" "SELECT
    CASE
        WHEN key LIKE 'cursorAuth/%' THEN 'cursorAuth/*'
        WHEN key LIKE 'cursor.%' THEN 'cursor.*'
        WHEN key LIKE 'cursor/%' THEN 'cursor/*'
        WHEN key LIKE 'cursorai/%' THEN 'cursorai/*'
        WHEN key LIKE 'workbench.contrib.onboarding.%' THEN 'workbench.contrib.onboarding.*'
    END as category, COUNT(*) as count
    FROM ItemTable GROUP BY category;" | while IFS='|' read -r cat count; do
    echo "     - $cat: $count keys"
done

# Export to gzip-compressed base64 (fits GitHub secrets 48KB limit)
gzip -c "$TEMP_DB" | base64 > "$OUTPUT_FILE"

# Cleanup
rm -f "$TEMP_DB"

# Show result
OUTPUT_SIZE=$(wc -c < "$OUTPUT_FILE" | tr -d ' ')
echo ""
echo "✅ Cursor auth exported successfully!"
echo "   File size: $OUTPUT_SIZE bytes (gzip + base64)"
echo "   Location: $OUTPUT_FILE"
echo ""

# Attempt to set GitHub secret if gh CLI is available
if command -v gh &> /dev/null; then
    echo "🔐 Setting GitHub secret CURSOR_STATE_VSCDB_B64..."
    if gh secret set CURSOR_STATE_VSCDB_B64 --repo mobb-dev/autofixer < "$OUTPUT_FILE" 2>/dev/null; then
        echo "✅ GitHub secret updated successfully!"
    else
        echo "⚠️  Could not set GitHub secret (check gh auth status)"
        echo "   Manual setup: gh secret set CURSOR_STATE_VSCDB_B64 < $OUTPUT_FILE"
    fi
else
    echo "💡 To add to GitHub CI, install gh CLI and run:"
    echo "   gh secret set CURSOR_STATE_VSCDB_B64 < $OUTPUT_FILE"
fi
echo ""
echo "The E2E tests will automatically use this file."
echo "Run: npm run test:e2e:full"
