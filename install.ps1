# ============================================================
# API Override MCP — 一键安装脚本（Windows）
# ------------------------------------------------------------
# 用法：在仓库根目录右键 → 用 PowerShell 运行
#       或：powershell -ExecutionPolicy Bypass -File install.ps1
#
# 这个脚本会：
#   1) 检查 Node.js 版本 (>= 18)
#   2) 在 mcp-server/ 下跑 npm install
#   3) 把 MCP 配置写到 ~/.claude.json
#   4) 注册到 Windows 启动文件夹（开机自启，无控制台窗口）
#   5) 立即启动一次 server
# ============================================================

param(
    [int]$Port = 9876,
    [string]$Host_ = '127.0.0.1',
    [switch]$NoAutostart,
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Join-Path $repoRoot 'mcp-server'
$indexJs = Join-Path $serverDir 'index.js'
$startupDir = [Environment]::GetFolderPath('Startup')
$shimVbs = Join-Path $startupDir 'api-override-mcp.vbs'
$logFile = Join-Path $env:LOCALAPPDATA 'api-override-mcp\server.log'
$claudeConfig = Join-Path $env:USERPROFILE '.claude.json'

function Write-Step([string]$msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}

function Write-Ok([string]$msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn2([string]$msg) { Write-Host "    [!] $msg" -ForegroundColor Yellow }
function Write-Err2([string]$msg) { Write-Host "    [X] $msg" -ForegroundColor Red }

# ------------------------------------------------------------
# 1. 检查 Node
# ------------------------------------------------------------
Write-Step "检查 Node.js"
try {
    $nodeVer = (& node --version) 2>$null
    if ($LASTEXITCODE -ne 0) { throw "node 未安装" }
    $verNum = [int]($nodeVer.TrimStart('v').Split('.')[0])
    if ($verNum -lt 18) {
        Write-Err2 "Node 版本 $nodeVer 太老，至少需要 18。"
        Write-Host "    请装新版：https://nodejs.org/zh-cn/"
        exit 1
    }
    Write-Ok "Node $nodeVer"
} catch {
    Write-Err2 "未找到 node 命令。请先安装 Node.js (>=18)：https://nodejs.org/zh-cn/"
    exit 1
}

# ------------------------------------------------------------
# 2. npm install
# ------------------------------------------------------------
Write-Step "安装依赖 (mcp-server/npm install)"
Push-Location $serverDir
# Relax EAP around native commands — npm/node may write deprecation warnings to
# stderr which $EAP='Stop' would otherwise treat as terminating errors.
$savedEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & npm install --silent
    if ($LASTEXITCODE -ne 0) {
        Write-Err2 "npm install 失败 (exit $LASTEXITCODE)"
        exit 1
    }
    Write-Ok "依赖安装完成"
} finally {
    $ErrorActionPreference = $savedEAP
    Pop-Location
}

# ------------------------------------------------------------
# 3. 写入 ~/.claude.json
# ------------------------------------------------------------
Write-Step "配置 Claude Code (~/.claude.json)"
$mcpUrl = "http://$Host_`:$Port/mcp"

# Read existing config or start empty
if (Test-Path $claudeConfig) {
    try {
        $existing = Get-Content -Raw -Path $claudeConfig -Encoding UTF8 | ConvertFrom-Json
    } catch {
        Write-Warn2 "现有 .claude.json 解析失败，备份后新建"
        Copy-Item $claudeConfig "$claudeConfig.bak.$(Get-Date -Format 'yyyyMMddHHmmss')"
        $existing = [pscustomobject]@{}
    }
} else {
    $existing = [pscustomobject]@{}
}

# Ensure mcpServers key
if (-not ($existing.PSObject.Properties.Name -contains 'mcpServers')) {
    $existing | Add-Member -MemberType NoteProperty -Name 'mcpServers' -Value ([pscustomobject]@{})
}

$entry = [pscustomobject]@{
    type = 'http'
    url  = $mcpUrl
}

if ($existing.mcpServers.PSObject.Properties.Name -contains 'api-override') {
    $existing.mcpServers.'api-override' = $entry
    Write-Ok "更新已有 'api-override' 配置 → $mcpUrl"
} else {
    $existing.mcpServers | Add-Member -MemberType NoteProperty -Name 'api-override' -Value $entry
    Write-Ok "添加 'api-override' 配置 → $mcpUrl"
}

# Write back, depth 32 to be safe
$json = $existing | ConvertTo-Json -Depth 32
[System.IO.File]::WriteAllText($claudeConfig, $json, [System.Text.UTF8Encoding]::new($false))
Write-Ok "已写入 $claudeConfig"

# ------------------------------------------------------------
# 4. 自启动 (Startup folder + .vbs shim 隐藏窗口)
# ------------------------------------------------------------
# 设计：在仓库目录写一个 run-server.cmd 做真正的启动逻辑（处理路径含空格、
# 重定向日志），启动文件夹里只放一个极简 .vbs 用 sh.Run 0 静默调起 cmd。
# 这样 VBS 字符串里只有一个 path，不会被引号嵌套坑。
$runCmd = Join-Path $serverDir 'run-server.cmd'

if (-not $NoAutostart) {
    Write-Step "注册开机自启"

    # Make sure log dir exists
    $logDir = Split-Path -Parent $logFile
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

    # Absolute node.exe path so PATH-less environments (e.g., login session
    # before user profile is fully ready) still work.
    $nodeExe = (Get-Command node).Source

    # 1) The .cmd that actually starts the server. cmd.exe handles quoted
    #    paths-with-spaces natively — no VBS escaping needed.
    $cmdContent = @"
@echo off
setlocal
set API_OVERRIDE_PORT=$Port
set API_OVERRIDE_HOST=$Host_
"$nodeExe" "$indexJs" >> "$logFile" 2>&1
"@
    [System.IO.File]::WriteAllText($runCmd, $cmdContent, [System.Text.Encoding]::ASCII)

    # 2) The VBS that calls the .cmd hidden (window style 0 = no console flash).
    #    Path is wrapped in Chr(34) to handle any future spaces robustly.
    $vbsContent = @"
' Auto-generated by api-override-mcp install.ps1 — silently launches run-server.cmd at login.
Set sh = CreateObject("WScript.Shell")
sh.Run Chr(34) & "$runCmd" & Chr(34), 0, False
"@
    [System.IO.File]::WriteAllText($shimVbs, $vbsContent, [System.Text.Encoding]::ASCII)

    Write-Ok "已写入启动器: $runCmd"
    Write-Ok "已写入启动项: $shimVbs"
    Write-Host "        日志位置: $logFile"
} else {
    Write-Warn2 "已跳过自启动注册 (-NoAutostart)"
    # Even without autostart, generate run-server.cmd so the user can double-click
    # it manually if they want a one-shot startup.
    if (-not (Test-Path $runCmd)) {
        $nodeExe = (Get-Command node).Source
        $cmdContent = @"
@echo off
setlocal
set API_OVERRIDE_PORT=$Port
set API_OVERRIDE_HOST=$Host_
"$nodeExe" "$indexJs"
"@
        [System.IO.File]::WriteAllText($runCmd, $cmdContent, [System.Text.Encoding]::ASCII)
    }
}

# ------------------------------------------------------------
# 5. 立即启动一次
# ------------------------------------------------------------
if (-not $NoStart) {
    Write-Step "启动 mcp-server"

    # Kill any existing instance on the same port (best-effort)
    try {
        $existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if ($existing) {
            $pids = $existing | Select-Object -ExpandProperty OwningProcess -Unique
            foreach ($oldPid in $pids) {
                $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
                if ($proc -and $proc.ProcessName -eq 'node') {
                    Write-Warn2 "端口 $Port 已被旧实例占用 (PID $oldPid)，正在关闭"
                    Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
                    Start-Sleep -Milliseconds 500
                }
            }
        }
    } catch { }

    if (Test-Path $shimVbs) {
        # Use the same shim we just installed (silent, logged)
        Start-Process 'wscript.exe' -ArgumentList "`"$shimVbs`""
        Write-Ok "已通过启动项静默启动（无窗口，输出写到 $logFile）"
    } elseif (Test-Path $runCmd) {
        # No autostart, but we have the .cmd — launch it in a visible window so user sees logs
        Start-Process 'cmd.exe' -ArgumentList '/k', "`"$runCmd`""
        Write-Ok "已在新窗口启动（前台，关闭窗口即停 server）"
    } else {
        # Last-resort fallback (shouldn't normally reach here)
        $env:API_OVERRIDE_PORT = $Port
        $env:API_OVERRIDE_HOST = $Host_
        Start-Process 'powershell' -ArgumentList '-NoExit', '-Command', "node `"$indexJs`""
        Write-Ok "已在新窗口启动（前台）"
    }

    # Probe /status — give it more time on slower machines (npm install just ran,
    # disk cache still warming up, wscript→cmd→node chain takes a beat).
    $ok = $false
    foreach ($wait in 2, 2, 3) {
        Start-Sleep -Seconds $wait
        try {
            $resp = Invoke-RestMethod -Uri "http://$Host_`:$Port/status" -TimeoutSec 3 -ErrorAction Stop
            if ($resp.ok) {
                Write-Ok "Server 健康检查通过：extensionConnected=$($resp.extensionConnected)"
                $ok = $true
                break
            }
        } catch { }
    }
    if (-not $ok) {
        Write-Warn2 "健康检查超时。可能原因："
        Write-Host "        1. 看日志: $logFile"
        Write-Host "        2. 手动跑试试: node `"$indexJs`""
        Write-Host "        3. 端口被占? Get-NetTCPConnection -LocalPort $Port -State Listen"
    }
} else {
    Write-Warn2 "已跳过立即启动 (-NoStart)"
}

# ------------------------------------------------------------
# 完成
# ------------------------------------------------------------
Write-Host ""
Write-Host "===========================================" -ForegroundColor Green
Write-Host " 安装完成！" -ForegroundColor Green
Write-Host "===========================================" -ForegroundColor Green
Write-Host ""
Write-Host "接下来要做的最后一件事："
Write-Host "  在 Chrome 打开 chrome://extensions"
Write-Host "  开启右上角 [开发者模式]"
Write-Host "  点 [加载已解压的扩展] -> 选择目录："
Write-Host "    $repoRoot\extension"
Write-Host ""
Write-Host "Claude Code 配置已自动写入 ($claudeConfig)，重启 Claude Code 即可使用。"
Write-Host "MCP 入口： $mcpUrl"
Write-Host ""
Write-Host "卸载：在仓库根目录运行  .\uninstall.ps1"
Write-Host ""
