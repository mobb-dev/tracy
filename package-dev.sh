#!/bin/bash
# package-dev.sh
# Build a development VSIX that can be installed alongside the marketplace version

set -e
cd -- "$( dirname -- "${BASH_SOURCE[0]}" )"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Constants
DEV_EXTENSION_ID="Mobb.mobb-ai-tracer-dev"

# Defaults
ENV="local"
API_URL=""
WEB_URL=""

# Help message
show_help() {
    echo "Usage: ./package-dev.sh [OPTIONS]"
    echo ""
    echo "Build a development VSIX with configurable environment settings."
    echo "The dev extension uses a different ID so it can run alongside the marketplace version."
    echo ""
    echo "Options:"
    echo "  --env ENV       Environment preset: local (default), staging, prod"
    echo "  --api-url URL   Override API URL"
    echo "  --web-url URL   Override Web App URL"
    echo "  -h, --help      Show this help message"
    echo ""
    echo "Environment presets:"
    echo "  local:   http://localhost:8080/v1/graphql, http://localhost:5173"
    echo "  staging: https://api-st-stenant.mobb.dev/v1/graphql, https://st-stenant.mobb.dev"
    echo "  prod:    https://api.mobb.ai/v1/graphql, https://app.mobb.ai"
    echo ""
    echo "Examples:"
    echo "  ./package-dev.sh                    # Build with local env (default)"
    echo "  ./package-dev.sh --env staging      # Build with staging env"
    echo "  ./package-dev.sh --env prod         # Build with prod env"
    echo "  ./package-dev.sh --api-url http://custom:8080/v1/graphql"
}

# Set URLs based on environment (consolidated)
set_env_urls() {
    local env=$1
    case $env in
        local)
            API_URL="http://localhost:8080/v1/graphql"
            WEB_URL="http://localhost:5173"
            ;;
        staging)
            API_URL="https://api-st-stenant.mobb.dev/v1/graphql"
            WEB_URL="https://st-stenant.mobb.dev"
            ;;
        prod)
            API_URL="https://api.mobb.ai/v1/graphql"
            WEB_URL="https://app.mobb.ai"
            ;;
    esac
}

# Install extension to an editor
install_to_editor() {
    local cli_cmd=$1
    local display_name=$2

    if command -v "$cli_cmd" &> /dev/null; then
        echo "  Uninstalling old dev extension from $display_name..."
        "$cli_cmd" --uninstall-extension "$DEV_EXTENSION_ID" 2>/dev/null || true
        echo "  Installing new dev extension to $display_name..."
        "$cli_cmd" --install-extension "$VSIX_FILE"
        echo -e "  ${GREEN}Installed to $display_name${NC}"
    else
        echo -e "  ${YELLOW}$display_name CLI ($cli_cmd) not found, skipping${NC}"
    fi
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --env) ENV="$2"; shift 2 ;;
    --api-url) API_URL="$2"; shift 2 ;;
    --web-url) WEB_URL="$2"; shift 2 ;;
    -h|--help) show_help; exit 0 ;;
    *) echo -e "${RED}Unknown option: $1${NC}"; show_help; exit 1 ;;
  esac
done

# Validate environment
if [[ "$ENV" != "local" && "$ENV" != "staging" && "$ENV" != "prod" ]]; then
    echo -e "${RED}Invalid environment: $ENV${NC}"
    echo "Valid options: local, staging, prod"
    exit 1
fi

# Set URLs if not overridden via CLI
if [[ -z "$API_URL" && -z "$WEB_URL" ]]; then
    set_env_urls "$ENV"
elif [[ -z "$API_URL" ]]; then
    # Only API_URL missing, get default for this env
    case $ENV in
        local) API_URL="http://localhost:8080/v1/graphql" ;;
        staging) API_URL="https://api-st-stenant.mobb.dev/v1/graphql" ;;
        prod) API_URL="https://api.mobb.ai/v1/graphql" ;;
    esac
elif [[ -z "$WEB_URL" ]]; then
    # Only WEB_URL missing, get default for this env
    case $ENV in
        local) WEB_URL="http://localhost:5173" ;;
        staging) WEB_URL="https://st-stenant.mobb.dev" ;;
        prod) WEB_URL="https://app.mobb.ai" ;;
    esac
fi

echo -e "${GREEN}Building dev extension for environment: ${YELLOW}$ENV${NC}"
echo -e "  API URL: $API_URL"
echo -e "  Web URL: $WEB_URL"
echo ""

# Backup original package.json and package-lock.json
echo "Backing up package.json and package-lock.json..."
cp package.json package.json.bak
cp package-lock.json package-lock.json.bak

# Backup existing .env if present
if [[ -f .env ]]; then
    echo "Backing up existing .env file..."
    cp .env .env.bak
fi

# Function to restore files on exit (success or failure)
cleanup() {
    if [[ -f package.json.bak ]]; then
        mv package.json.bak package.json
        echo "Restored original package.json"
    fi
    if [[ -f package-lock.json.bak ]]; then
        mv package-lock.json.bak package-lock.json
        echo "Restored original package-lock.json"
    fi
    if [[ -f .env.bak ]]; then
        mv .env.bak .env
        echo "Restored original .env file"
    elif [[ -f .env ]]; then
        rm .env
        echo "Removed dev .env file"
    fi
}
trap cleanup EXIT

# Verify dev icon exists (committed to repo)
if [[ ! -f icon-dev.png ]]; then
    echo -e "${YELLOW}icon-dev.png not found, using original icon${NC}"
    cp icon.png icon-dev.png
fi

# Create .env file with dev values
echo "Creating .env file for dev build..."
cat > .env << ENVEOF
API_URL=$API_URL
WEB_APP_URL=$WEB_URL
HASURA_ACCESS_KEY=dummy
LOCAL_GRAPHQL_ENDPOINT=http://localhost:8080/v1/graphql
DD_RUM_TOKEN=
ENVEOF

# Modify package.json for dev build
echo "Modifying package.json for dev build..."
node scripts/modify-package-for-dev.js "$API_URL" "$WEB_URL" "$ENV"

# Clean previous dev builds
echo ""
echo "Cleaning previous builds..."
rm -rf mobb-ai-tracer-dev-*.vsix
rm -rf node_modules
rm -rf out

# Install dependencies and build
echo ""
echo "Installing dependencies..."
npm install --legacy-peer-deps

echo ""
echo "Building..."
npm run build

echo ""
echo "Packaging VSIX..."
npx vsce package --allow-package-env-file

# Get the generated VSIX filename
VSIX_FILE=$(ls mobb-ai-tracer-dev-*.vsix 2>/dev/null | head -1)

if [[ -z "$VSIX_FILE" ]]; then
    echo -e "${RED}Failed to create VSIX file${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}Dev VSIX created: ${YELLOW}$VSIX_FILE${NC}"

# Install to editors
echo ""
echo "Installing to editors..."
install_to_editor "code" "VS Code"
install_to_editor "cursor" "Cursor"

echo ""
echo -e "${GREEN}Done!${NC}"
echo -e "${YELLOW}Please restart your editor to activate the dev extension.${NC}"
