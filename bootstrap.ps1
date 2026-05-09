# ============================================================
# API Override MCP — 一行命令在线安装器（Windows）
# ------------------------------------------------------------
# 用户用法（在 PowerShell 里）：
#   irm https://raw.githubusercontent.com/hanzhipeng0903/override-mcp/main/bootstrap.ps1 | iex
#
# 这个脚本会：
#   1) 从 GitHub Releases 下载最新打包好的 zip（已 bundle + 混淆，不含源码）
#   2) 解压到 %LOCALAPPDATA%\override-mcp
#   3) 调用 install.ps1（写 Claude Code 配置 + 注册自启 + 启动）
#   4) 引导用户加载扩展（剪贴板复制路径 + 打开 chrome://extensions）
#
# 可重复运行：再次跑会下最新 release 覆盖安装。
# ============================================================

param(
    [string]$Repo = 'hanzhipeng0903/override-mcp',
    [string]$Tag = 'latest',
    [string]$AssetName = 'override-mcp-release.zip',
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'override-mcp'),
    [int]$Port = 9876,
    [switch]$NoAutostart,
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn2([string]$msg) { Write-Host "    [!] $msg" -ForegroundColor Yellow }
function Write-Err2([string]$msg)  { Write-Host "    [X] $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host " API Override MCP - 在线安装器 (Release 版)" -ForegroundColor Cyan
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host " 仓库:   $Repo"
Write-Host " Tag:    $Tag"
Write-Host " 装到:   $InstallDir"
Write-Host " 端口:   $Port"
Write-Host "=========================================================" -ForegroundColor Cyan

# ------------------------------------------------------------
# 1. 下载 Release zip
# ------------------------------------------------------------
Write-Step "下载发行包"

# 解析下载 URL（latest 用 GitHub 的 latest 端点；指定 tag 用 download URL）
if ($Tag -eq 'latest') {
    $downloadUrl = "https://github.com/$Repo/releases/latest/download/$AssetName"
} else {
    $downloadUrl = "https://github.com/$Repo/releases/download/$Tag/$AssetName"
}

$tmpZip = Join-Path $env:TEMP "override-mcp-release-$([guid]::NewGuid()).zip"
$tmpExtract = Join-Path $env:TEMP "override-mcp-extract-$([guid]::NewGuid())"

Write-Host "    URL: $downloadUrl"
try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile $tmpZip -UseBasicParsing
} catch {
    Write-Err2 "下载失败：$($_.Exception.Message)"
    Write-Host "    可能原因：仓库还没有 Release / 网络问题 / 资源名不对"
    Write-Host "    检查：https://github.com/$Repo/releases"
    exit 1
}

$zipSize = (Get-Item $tmpZip).Length
Write-Ok "已下载 ($([math]::Round($zipSize/1KB, 1)) KB)"

# ------------------------------------------------------------
# 2. 解压到目标目录（先备份旧目录）
# ------------------------------------------------------------
Write-Step "解压安装"

# 先停掉可能在跑的旧 server，避免文件锁
try {
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($conns) {
        $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($oldPid in $pids) {
            $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
            if ($proc -and $proc.ProcessName -eq 'node') {
                Write-Host "    停掉旧 server (PID $oldPid)"
                Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
                Start-Sleep -Milliseconds 500
            }
        }
    }
} catch { }

# 备份旧安装目录
if (Test-Path $InstallDir) {
    $backupName = "$InstallDir.bak.$(Get-Date -Format 'yyyyMMddHHmmss')"
    try {
        Move-Item -Path $InstallDir -Destination $backupName -Force
        Write-Host "    旧目录 → $backupName"
    } catch {
        Write-Warn2 "无法备份旧目录（可能有进程占用），尝试直接覆盖"
        Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# 解压
Expand-Archive -Path $tmpZip -DestinationPath $InstallDir -Force
Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue
if (Test-Path $tmpExtract) { Remove-Item $tmpExtract -Recurse -Force -ErrorAction SilentlyContinue }
Write-Ok "已解压到 $InstallDir"

# ------------------------------------------------------------
# 3. 跑发行包里的 install.ps1
# ------------------------------------------------------------
$installScript = Join-Path $InstallDir 'install.ps1'
if (-not (Test-Path $installScript)) {
    Write-Err2 "找不到 install.ps1（路径：$installScript）。zip 结构异常。"
    exit 1
}

Write-Step "执行 install.ps1"
$installArgs = @('-Port', $Port)
if ($NoAutostart) { $installArgs += '-NoAutostart' }
if ($NoStart)     { $installArgs += '-NoStart' }

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installScript @installArgs
if ($LASTEXITCODE -ne 0) {
    Write-Err2 "install.ps1 失败 (exit $LASTEXITCODE)"
    exit $LASTEXITCODE
}

# ------------------------------------------------------------
# 完成（install.ps1 自身已打印加载扩展指引）
# ------------------------------------------------------------
Write-Host ""
Write-Host "=========================================================" -ForegroundColor Green
Write-Host " 全部完成" -ForegroundColor Green
Write-Host "=========================================================" -ForegroundColor Green
Write-Host ""
Write-Host " 卸载: powershell -ExecutionPolicy Bypass -File `"$InstallDir\uninstall.ps1`""
Write-Host " 更新: 重新跑 irm | iex 即可"
Write-Host ""
