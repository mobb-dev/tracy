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
  if (-not $env:AWS_BEDROCK_ACCESS_KEY_ID_V2 -or -not $env:AWS_BEDROCK_ACCESS_KEY_V2) {
    Write-Error "MapBedrock requested but AWS_BEDROCK_ACCESS_KEY_ID_V2 or AWS_BEDROCK_ACCESS_KEY_V2 is missing — refusing to export empty AWS credentials"
    exit 1
  }

  $region = if ($env:AWS_BEDROCK_REGION) { $env:AWS_BEDROCK_REGION } else { "us-west-2" }

  Write-Host "::add-mask::$($env:AWS_BEDROCK_ACCESS_KEY_ID_V2)"
  Write-Host "::add-mask::$($env:AWS_BEDROCK_ACCESS_KEY_V2)"

  "AWS_ACCESS_KEY_ID=$($env:AWS_BEDROCK_ACCESS_KEY_ID_V2)" | Out-File -FilePath $env:GITHUB_ENV -Append
  "AWS_SECRET_ACCESS_KEY=$($env:AWS_BEDROCK_ACCESS_KEY_V2)" | Out-File -FilePath $env:GITHUB_ENV -Append
  "AWS_DEFAULT_REGION=$region" | Out-File -FilePath $env:GITHUB_ENV -Append
  "AWS_REGION=$region" | Out-File -FilePath $env:GITHUB_ENV -Append
  "CLAUDE_CODE_USE_BEDROCK=1" | Out-File -FilePath $env:GITHUB_ENV -Append

  Write-Host "Mapped Bedrock credentials (region: $region)"
}

Write-Host "Environment loaded"
