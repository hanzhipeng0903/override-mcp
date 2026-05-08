# Idempotent starter for api-override-mcp.
# - If already listening on the port, prints a one-liner and exits 0.
# - Otherwise starts node index.js detached, waits briefly, and verifies.
#
# Usage:
#   .\ensure-running.ps1            # default port 9876
#   .\ensure-running.ps1 -Port 9000

param(
  [int]$Port = 9876
)

$ErrorActionPreference = 'Stop'

$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  $existingPid = $listening.OwningProcess[0]
  Write-Host "[api-override] already running on PID $existingPid (port $Port)"
  exit 0
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$indexJs   = Join-Path $scriptDir 'index.js'
$logOut    = Join-Path $scriptDir 'server.out.log'
$logErr    = Join-Path $scriptDir 'server.err.log'

if (-not (Test-Path $indexJs)) {
  Write-Host "[api-override] missing $indexJs" -ForegroundColor Red
  exit 1
}

$env:API_OVERRIDE_PORT = "$Port"
$proc = Start-Process -FilePath 'node' `
                      -ArgumentList $indexJs `
                      -WorkingDirectory $scriptDir `
                      -WindowStyle Hidden `
                      -RedirectStandardOutput $logOut `
                      -RedirectStandardError  $logErr `
                      -PassThru

# Wait up to 3 seconds for the port to come up
$deadline = (Get-Date).AddSeconds(3)
$bound = $null
while ((Get-Date) -lt $deadline) {
  $bound = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($bound) { break }
  Start-Sleep -Milliseconds 200
}

if (-not $bound) {
  Write-Host "[api-override] FAILED to bind port $Port within 3s. Check $logErr" -ForegroundColor Red
  if (Test-Path $logErr) { Get-Content $logErr -Tail 20 }
  exit 1
}

Write-Host "[api-override] started on PID $($bound.OwningProcess[0]) (port $Port, logs: $logErr)"
