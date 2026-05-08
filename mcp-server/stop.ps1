# Stop a running api-override-mcp server.
#
# Usage:
#   .\stop.ps1            # default port 9876
#   .\stop.ps1 -Port 9000

param(
  [int]$Port = 9876
)

$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  Write-Host "[api-override] not running (port $Port is free)"
  exit 0
}

$targetPid = $listening.OwningProcess[0]
Stop-Process -Id $targetPid -Force
Start-Sleep -Milliseconds 300
$still = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($still) {
  Write-Host "[api-override] failed to stop PID $targetPid" -ForegroundColor Red
  exit 1
}
Write-Host "[api-override] stopped PID $targetPid"
