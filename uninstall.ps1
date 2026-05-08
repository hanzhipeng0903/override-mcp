# ============================================================
# API Override MCP — 卸载脚本（Windows）
# ------------------------------------------------------------
# 干掉 install.ps1 装上的所有东西：
#   1) 停掉正在跑的 server 进程
#   2) 删掉启动文件夹里的自启 .vbs
#   3) 从 ~/.claude.json 移除 'api-override' 条目
#
# 不删除：仓库本身、node_modules、日志文件
# ============================================================

param(
    [int]$Port = 9876,
    [switch]$KeepConfig
)

$ErrorActionPreference = 'Continue'
$startupDir = [Environment]::GetFolderPath('Startup')
$shimVbs = Join-Path $startupDir 'api-override-mcp.vbs'
$claudeConfig = Join-Path $env:USERPROFILE '.claude.json'

function Write-Step([string]$msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}
function Write-Ok([string]$msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn2([string]$msg) { Write-Host "    [!] $msg" -ForegroundColor Yellow }

# 1. 停掉跑着的 server (按端口找)
Write-Step "停掉运行中的 server"
try {
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($conns) {
        $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($oldPid in $pids) {
            $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
            if ($proc -and $proc.ProcessName -eq 'node') {
                Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
                Write-Ok "已停止 node 进程 PID $oldPid"
            }
        }
    } else {
        Write-Ok "没有 server 在跑（端口 $Port 空闲）"
    }
} catch {
    Write-Warn2 "无法查询端口占用：$($_.Exception.Message)"
}

# 2. 删启动项
Write-Step "移除开机自启"
if (Test-Path $shimVbs) {
    Remove-Item $shimVbs -Force
    Write-Ok "已删除 $shimVbs"
} else {
    Write-Warn2 "未找到自启文件 (可能没装过或路径变了)"
}

# 3. 从 ~/.claude.json 移除 api-override
if (-not $KeepConfig) {
    Write-Step "清理 ~/.claude.json 里的 api-override 条目"
    if (Test-Path $claudeConfig) {
        try {
            $cfg = Get-Content -Raw -Path $claudeConfig -Encoding UTF8 | ConvertFrom-Json
            if ($cfg.PSObject.Properties.Name -contains 'mcpServers' `
                -and $cfg.mcpServers.PSObject.Properties.Name -contains 'api-override') {
                $cfg.mcpServers.PSObject.Properties.Remove('api-override')
                $json = $cfg | ConvertTo-Json -Depth 32
                [System.IO.File]::WriteAllText($claudeConfig, $json, [System.Text.UTF8Encoding]::new($false))
                Write-Ok "已从 .claude.json 移除 api-override"
            } else {
                Write-Warn2 "没有找到 api-override 条目，跳过"
            }
        } catch {
            Write-Warn2 "解析 .claude.json 失败：$($_.Exception.Message)"
        }
    } else {
        Write-Warn2 "未找到 ~/.claude.json"
    }
} else {
    Write-Warn2 "已跳过清理配置 (-KeepConfig)"
}

Write-Host ""
Write-Host "===========================================" -ForegroundColor Green
Write-Host " 卸载完成" -ForegroundColor Green
Write-Host "===========================================" -ForegroundColor Green
Write-Host ""
Write-Host "扩展需要手动移除：chrome://extensions → 找到 'API Override (MCP)' → 移除"
Write-Host "仓库目录、node_modules、日志文件未删除，按需手工清理即可。"
Write-Host ""
