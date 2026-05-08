# ============================================================
# API Override MCP — 一行命令在线安装器（Windows）
# ------------------------------------------------------------
# 用户用法（在 PowerShell 里）：
#   irm https://raw.githubusercontent.com/hanzhipeng0903/override-mcp/main/bootstrap.ps1 | iex
#
# 这个脚本会：
#   1) 把仓库下到 %LOCALAPPDATA%\override-mcp（有 git 用 git clone，没有就下 zip）
#   2) 调用仓库里的 install.ps1（依赖安装、Claude Code 配置、自启动、立即启动）
#   3) 提示用户去 chrome://extensions 加载扩展
#
# 可重复运行：已经装过会自动 git pull 更新到最新版。
# ============================================================

param(
    [string]$Repo = 'hanzhipeng0903/override-mcp',
    [string]$Branch = 'main',
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'override-mcp'),
    [int]$Port = 9876,
    [switch]$NoAutostart,
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}
function Write-Ok([string]$msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn2([string]$msg) { Write-Host "    [!] $msg" -ForegroundColor Yellow }
function Write-Err2([string]$msg)  { Write-Host "    [X] $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host " API Override MCP - 在线安装器" -ForegroundColor Cyan
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host " 仓库:   $Repo (branch: $Branch)"
Write-Host " 装到:   $InstallDir"
Write-Host " 端口:   $Port"
Write-Host "=========================================================" -ForegroundColor Cyan

# ------------------------------------------------------------
# 1. 拉代码：优先 git clone，没 git 就走 zip 下载
# ------------------------------------------------------------
Write-Step "下载源代码"

$hasGit = $false
try { & git --version *>$null; if ($LASTEXITCODE -eq 0) { $hasGit = $true } } catch {}

if ($hasGit) {
    if (Test-Path (Join-Path $InstallDir '.git')) {
        Write-Host "    已存在 git 仓库，执行 git pull 更新..."
        Push-Location $InstallDir
        try {
            & git fetch origin $Branch 2>&1 | Out-Null
            & git reset --hard "origin/$Branch" 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "git reset 失败" }
            Write-Ok "已更新到最新 $Branch"
        } finally {
            Pop-Location
        }
    } else {
        if (Test-Path $InstallDir) {
            Write-Warn2 "目录 $InstallDir 已存在但不是 git 仓库，备份后重新克隆"
            $backupName = "$InstallDir.bak.$(Get-Date -Format 'yyyyMMddHHmmss')"
            Rename-Item -Path $InstallDir -NewName $backupName
            Write-Host "    旧目录 → $backupName"
        }
        Write-Host "    git clone https://github.com/$Repo.git ..."
        & git clone --depth 1 --branch $Branch "https://github.com/$Repo.git" $InstallDir 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Err2 "git clone 失败"; exit 1 }
        Write-Ok "已 clone 到 $InstallDir"
    }
} else {
    Write-Warn2 "未检测到 git，改用 zip 下载（无法增量更新）"
    $zipUrl = "https://codeload.github.com/$Repo/zip/refs/heads/$Branch"
    $tmpZip = Join-Path $env:TEMP "override-mcp-$Branch.zip"
    $tmpExtract = Join-Path $env:TEMP "override-mcp-extract-$([guid]::NewGuid())"

    if (Test-Path $InstallDir) {
        $backupName = "$InstallDir.bak.$(Get-Date -Format 'yyyyMMddHHmmss')"
        Rename-Item -Path $InstallDir -NewName $backupName
        Write-Host "    旧目录已备份 → $backupName"
    }

    Write-Host "    下载 $zipUrl ..."
    Invoke-WebRequest -Uri $zipUrl -OutFile $tmpZip -UseBasicParsing
    Write-Host "    解压..."
    Expand-Archive -Path $tmpZip -DestinationPath $tmpExtract -Force
    # zip 解出的根目录会带 -<branch> 后缀，移到目标位置
    $inner = Get-ChildItem $tmpExtract | Select-Object -First 1
    Move-Item -Path $inner.FullName -Destination $InstallDir
    Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue
    Remove-Item $tmpExtract -Recurse -Force -ErrorAction SilentlyContinue
    Write-Ok "已解压到 $InstallDir"
}

# ------------------------------------------------------------
# 2. 跑仓库自带的 install.ps1
# ------------------------------------------------------------
$installScript = Join-Path $InstallDir 'install.ps1'
if (-not (Test-Path $installScript)) {
    Write-Err2 "找不到 install.ps1（路径：$installScript）。仓库结构异常。"
    exit 1
}

$installArgs = @('-Port', $Port)
if ($NoAutostart) { $installArgs += '-NoAutostart' }
if ($NoStart)     { $installArgs += '-NoStart' }

Write-Step "执行 install.ps1"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installScript @args
if ($LASTEXITCODE -ne 0) {
    Write-Err2 "install.ps1 失败 (exit $LASTEXITCODE)"
    exit $LASTEXITCODE
}

# ------------------------------------------------------------
# 3. 引导加载扩展
# ------------------------------------------------------------
$extPath = Join-Path $InstallDir 'extension'

Write-Host ""
Write-Host "=========================================================" -ForegroundColor Green
Write-Host " 安装完成 - 还差最后一步：加载浏览器扩展" -ForegroundColor Green
Write-Host "=========================================================" -ForegroundColor Green
Write-Host ""
Write-Host " 1. Chrome 打开:   chrome://extensions"
Write-Host " 2. 右上角开:      [开发者模式]"
Write-Host " 3. 点:            [加载已解压的扩展程序]"
Write-Host " 4. 选目录:" -NoNewline; Write-Host " $extPath" -ForegroundColor Yellow
Write-Host ""
Write-Host " 装完后:"
Write-Host "   - 扩展 popup 顶部 pill 显示绿色 connected 即握手成功"
Write-Host "   - 重启 Claude Code，即可让 AI 直接对网页 mock 接口"
Write-Host ""
Write-Host " 卸载:"
Write-Host "   powershell -ExecutionPolicy Bypass -File `"$InstallDir\uninstall.ps1`""
Write-Host ""

# 自动把 extension 路径复制到剪贴板，方便用户粘贴
try {
    $extPath | Set-Clipboard
    Write-Host " （扩展目录路径已自动复制到剪贴板）" -ForegroundColor DarkGray
    Write-Host ""
} catch {}

# 自动打开 chrome://extensions（best-effort）
try {
    Start-Process 'chrome' -ArgumentList 'chrome://extensions' -ErrorAction SilentlyContinue
} catch {}
