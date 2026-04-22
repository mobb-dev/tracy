$ErrorActionPreference = 'Stop'

Write-Host "================================="
Write-Host "Starting Claude Code Extension E2E Test (Windows)"
Write-Host "================================="

# Ensure test-results directory exists
$resultsDir = "C:\workspace\clients\tracer_ext\test-results"
New-Item -ItemType Directory -Force -Path $resultsDir | Out-Null

Write-Host "Claude Code version:"
claude --version
Write-Host ""

Write-Host "Mobbdev CLI:"
mobbdev --version
Write-Host ""

Write-Host "Starting tests..."
Set-Location "C:\workspace\clients\tracer_ext"

$testDir = "__tests__/e2e/claude-code"
Write-Host "Running Windows tests in: $testDir"

npx vitest run --no-file-parallelism $testDir
$testExitCode = $LASTEXITCODE

# Show final status
if ($testExitCode -eq 0) {
    Write-Host ""
    Write-Host "================================"
    Write-Host "E2E Tests PASSED"
    Write-Host "================================"
} else {
    Write-Host ""
    Write-Host "================================"
    Write-Host "E2E Tests FAILED"
    Write-Host "================================"
}

exit $testExitCode
