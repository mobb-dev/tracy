# Load .env file and export variables to GITHUB_ENV for subsequent workflow steps.
#
# SECURITY NOTE: values written via $env:GITHUB_ENV are NOT automatically masked
# by GitHub Actions — only job-level `secrets.*` references are. This script
# emits `::add-mask::` directives for known-sensitive keys before writing them.
#
# Usage: pwsh -File load-env.ps1 [-EnvFile <path>] [-MapBedrock]
#
# -EnvFile: Path to .env file (default: $env:GITHUB_WORKSPACE/.env)
# -MapBedrock: Map AWS_BEDROCK_* vars to AWS_ACCESS_KEY_ID/SECRET and set CLAUDE_CODE_USE_BEDROCK

param(
  [string]$EnvFile = (Join-Path $env:GITHUB_WORKSPACE ".env"),
  [switch]$MapBedrock
)

if (-not (Test-Path $EnvFile)) {
  Write-Host "No .env file found at $EnvFile"
  exit 0
}

# Keys (or substrings) whose value must be masked in CI logs before being
# exported via GITHUB_ENV. Anything matched here emits ::add-mask:: first.
$sensitivePatterns = @(
  'TOKEN', 'SECRET', 'PASSWORD', 'PRIVATE_KEY', 'PAT',
  'AWS_', 'ANTHROPIC_API_KEY', 'GITHUB_', 'DOTENV_',
  # LiteLLM proxy virtual key (sk-...). Comes from the dotenv vault, not a GitHub
  # secret, so it is NOT auto-masked — and its name matches none of the patterns above.
  'LLM_PROXY_CI_KEY',
  'VSCODE_STATE_VSCDB_B64', 'CURSOR_STATE_VSCDB_B64'
)
function Test-IsSensitive([string]$name) {
  foreach ($pat in $sensitivePatterns) {
    if ($name -match $pat) { return $true }
  }
  return $false
}

# Strip matching outer quote pairs only (not every leading/trailing quote).
function Remove-OuterQuotes([string]$value) {
  if ($value.Length -ge 2 -and (
      ($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'"))
    )) {
    return $value.Substring(1, $value.Length - 2)
  }
  return $value
}

# PATH-like variables that could inject malicious binary resolution paths
# or Node preload scripts into later steps. Reject from .env import.
$rejectedKeys = @('PATH', 'NODE_OPTIONS', 'NODE_PATH')

Write-Host "Loading environment from $EnvFile..."

Get-Content $EnvFile | ForEach-Object {
  # Skip empty lines and full-line comments
  if ($_ -match '^\s*$' -or $_ -match '^\s*#') { return }

  # KEY must be a valid identifier; match optional surrounding whitespace
  if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') {
    $name = $matches[1]
    $value = Remove-OuterQuotes $matches[2].Trim()

    if ($rejectedKeys -contains $name) {
      Write-Host "  Skipping rejected key: $name (injection hazard)"
      return
    }

    # Set for current process
    [System.Environment]::SetEnvironmentVariable($name, $value, "Process")

    # Mask sensitive values before they land in GITHUB_ENV (otherwise any
    # downstream step that echoes env will leak them — GitHub does not mask
    # GITHUB_ENV-introduced values automatically).
    if ($value.Length -gt 0 -and (Test-IsSensitive $name)) {
      Write-Host "::add-mask::$value"
    }

    # Export for subsequent steps
    "$name=$value" | Out-File -FilePath $env:GITHUB_ENV -Append
  }
}

if ($MapBedrock) {
  # Route Claude Code through the LiteLLM proxy "gateway" — the sole path to Bedrock. The proxy
  # holds AWS creds and signs to real Bedrock with its own role; the client presents a LiteLLM
  # virtual key in a custom Authorization header. The sk- virtual key is NOT a valid AWS Bedrock
  # API key, so client-side AWS auth is skipped (the AWS SDK would reject it before any request
  # leaves the runner). Requires the proxy reachable (Twingate) + a provisioned key.
  if (-not $env:LLM_PROXY_BASE_URL -or -not $env:LITELLM_API_KEY) {
    Write-Error "MapBedrock requested but LLM_PROXY_BASE_URL or LITELLM_API_KEY is missing — Claude Code must reach Bedrock through the LiteLLM proxy gateway"
    exit 1
  }

  Write-Host "::add-mask::$($env:LITELLM_API_KEY)"

  "CLAUDE_CODE_USE_BEDROCK=1" | Out-File -FilePath $env:GITHUB_ENV -Append
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH=1" | Out-File -FilePath $env:GITHUB_ENV -Append
  "ANTHROPIC_BEDROCK_BASE_URL=$($env:LLM_PROXY_BASE_URL)/bedrock" | Out-File -FilePath $env:GITHUB_ENV -Append
  "ANTHROPIC_CUSTOM_HEADERS=Authorization: Bearer $($env:LITELLM_API_KEY)" | Out-File -FilePath $env:GITHUB_ENV -Append

  Write-Host "Configured Claude Code LiteLLM proxy gateway"
}

Write-Host "Environment loaded"
