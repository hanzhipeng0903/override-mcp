// ============================================================
// override-mcp release builder
// ------------------------------------------------------------
// Pipeline:
//   1. esbuild bundle mcp-server/index.js → ESM .mjs (top-level await OK)
//   2. javascript-obfuscator → heavy obfuscation
//   3. esbuild bundle + minify extension/background.js + popup.js
//   4. javascript-obfuscator (Manifest V3 CSP-safe options) on extension
//   5. Copy static assets (manifest.json, popup.html, icons, install scripts)
//   6. archiver → override-mcp-release.zip
// ============================================================

import { build as esbuild } from 'esbuild';
import obfuscator from 'javascript-obfuscator';
import archiver from 'archiver';
import { mkdir, rm, copyFile, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC_SERVER = resolve(ROOT, 'mcp-server');
const SRC_EXT = resolve(ROOT, 'extension');
const DIST = resolve(__dirname, 'dist');
const STAGE = resolve(DIST, 'override-mcp-release');
const RELEASE_ZIP = resolve(__dirname, 'override-mcp-release.zip');

const log = (...a) => console.log('[build]', ...a);

// ---- Obfuscator presets ----

// Server-side preset. Original "heavy" preset (controlFlowFlattening +
// deadCodeInjection + transformObjectKeys) broke zod's internal getter chains
// and caused infinite recursion at startup. Keeping only the AST-safe transforms:
// hex variable names + base64 string array + string splitting. Code is still
// thoroughly unreadable for casual inspection but doesn't mangle runtime semantics.
const OBF_HEAVY = {
  compact: true,
  controlFlowFlattening: false,        // breaks zod/ajv getter chains
  deadCodeInjection: false,            // can introduce eval-like traps
  identifierNamesGenerator: 'hexadecimal',
  numbersToExpressions: false,
  renameGlobals: false,
  selfDefending: false,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 10,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayShuffle: true,
  stringArrayThreshold: 0.75,
  transformObjectKeys: false,          // breaks computed-getter classes
  unicodeEscapeSequence: false
};

// Safe preset for browser extension (Manifest V3 CSP forbids eval).
// No controlFlowFlattening (CSP risk), no selfDefending, no rc4 string array
// (rc4 decoder uses Function in older versions).
const OBF_SAFE = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  identifierNamesGenerator: 'hexadecimal',
  numbersToExpressions: false,
  renameGlobals: false,
  selfDefending: false,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 12,
  stringArray: true,
  stringArrayEncoding: [], // plain — safest under MV3 CSP
  stringArrayShuffle: true,
  stringArrayThreshold: 0.6,
  transformObjectKeys: false,
  unicodeEscapeSequence: false
};

async function clean() {
  log('clean dist + previous zip');
  if (existsSync(DIST)) await rm(DIST, { recursive: true, force: true });
  if (existsSync(RELEASE_ZIP)) await rm(RELEASE_ZIP, { force: true });
  await mkdir(STAGE, { recursive: true });
}

async function buildServer() {
  log('bundle mcp-server with esbuild (ESM, node18)');
  const outDir = resolve(STAGE, 'mcp-server');
  await mkdir(outDir, { recursive: true });

  const tmp = resolve(DIST, '__tmp_server.mjs');
  await esbuild({
    entryPoints: [resolve(SRC_SERVER, 'index.js')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    outfile: tmp,
    minify: true,
    legalComments: 'none',
    // CommonJS deps (ws, ajv, ...) internally call require('events') etc.
    // When bundled into an ESM output, esbuild's __require stub doesn't know
    // Node builtins. Inject a real createRequire so those calls work.
    banner: {
      js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);"
    }
  });

  log('obfuscate mcp-server bundle');
  const code = await readFile(tmp, 'utf-8');
  const obfd = obfuscator.obfuscate(code, OBF_HEAVY).getObfuscatedCode();
  const outFile = resolve(outDir, 'index.mjs');
  await writeFile(outFile, obfd, 'utf-8');
  const sz = (await stat(outFile)).size;
  log(`  → ${outFile} (${(sz / 1024).toFixed(1)} KB)`);
}

async function buildExtensionScript(srcName, dstName) {
  const tmp = resolve(DIST, `__tmp_${srcName}`);
  await esbuild({
    entryPoints: [resolve(SRC_EXT, srcName)],
    bundle: true,
    platform: 'browser',
    target: 'chrome110',
    format: 'iife',
    outfile: tmp,
    minify: true,
    legalComments: 'none'
  });

  const code = await readFile(tmp, 'utf-8');
  const obfd = obfuscator.obfuscate(code, OBF_SAFE).getObfuscatedCode();
  const outFile = resolve(STAGE, 'extension', dstName);
  await writeFile(outFile, obfd, 'utf-8');
  const sz = (await stat(outFile)).size;
  log(`  → ${outFile} (${(sz / 1024).toFixed(1)} KB)`);
}

async function copyDir(src, dst) {
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = resolve(src, e.name);
    const d = resolve(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await copyFile(s, d);
  }
}

async function buildExtension() {
  log('bundle + obfuscate extension scripts');
  const extOut = resolve(STAGE, 'extension');
  await mkdir(extOut, { recursive: true });

  // copy manifest.json + popup.html + icons/ as-is
  await copyFile(resolve(SRC_EXT, 'manifest.json'), resolve(extOut, 'manifest.json'));
  await copyFile(resolve(SRC_EXT, 'popup.html'), resolve(extOut, 'popup.html'));
  if (existsSync(resolve(SRC_EXT, 'icons'))) {
    await copyDir(resolve(SRC_EXT, 'icons'), resolve(extOut, 'icons'));
  }

  // bundle JS files (output to same name so manifest.json doesn't need editing)
  await buildExtensionScript('background.js', 'background.js');
  await buildExtensionScript('popup.js', 'popup.js');
}

async function emitInstallScripts() {
  log('emit install/uninstall scripts (release-flavor, no npm install)');

  // install.ps1 — read from template (kept as separate file because PowerShell
  // backticks collide with JS template literal delimiters when inlined here)
  const installPs1 = await readFile(resolve(__dirname, 'templates', 'install.ps1'), 'utf-8');
  /* DEAD_CODE_START
# api-override-mcp - 安装脚本（发行包版本，不需要 npm install）
# ============================================================
param(
    [int]$Port = 9876,
    [string]$BindHost = '127.0.0.1',
    [switch]$NoAutostart,
    [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$indexJs = Join-Path $repoRoot 'mcp-server\\index.mjs'
$startupDir = [Environment]::GetFolderPath('Startup')
$shimVbs = Join-Path $startupDir 'api-override-mcp.vbs'
$logFile = Join-Path $env:LOCALAPPDATA 'api-override-mcp\\server.log'
$claudeConfig = Join-Path $env:USERPROFILE '.claude.json'
$runCmd = Join-Path $repoRoot 'mcp-server\\run-server.cmd'

function Write-Step([string]$msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg) { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn2([string]$msg) { Write-Host "    [!] $msg" -ForegroundColor Yellow }
function Write-Err2([string]$msg) { Write-Host "    [X] $msg" -ForegroundColor Red }

# 1. 检查 Node
Write-Step "检查 Node.js"
try {
    $nodeVer = (& node --version) 2>$null
    if ($LASTEXITCODE -ne 0) { throw "node 未安装" }
    $verNum = [int]($nodeVer.TrimStart('v').Split('.')[0])
    if ($verNum -lt 18) {
        Write-Err2 "Node 版本 $nodeVer 太老，至少需要 18。请装新版：https://nodejs.org/zh-cn/"
        exit 1
    }
    Write-Ok "Node $nodeVer"
} catch {
    Write-Err2 "未找到 node 命令。请先安装 Node.js (>=18)：https://nodejs.org/zh-cn/"
    exit 1
}

# 2. 写 ~/.claude.json
Write-Step "配置 Claude Code (~/.claude.json)"
$mcpUrl = "http://$BindHost`:$Port/mcp"
if (Test-Path $claudeConfig) {
    try { $existing = Get-Content -Raw -Path $claudeConfig -Encoding UTF8 | ConvertFrom-Json }
    catch {
        Write-Warn2 "现有 .claude.json 解析失败，备份后新建"
        Copy-Item $claudeConfig "$claudeConfig.bak.$(Get-Date -Format 'yyyyMMddHHmmss')"
        $existing = [pscustomobject]@{}
    }
} else { $existing = [pscustomobject]@{} }
if (-not ($existing.PSObject.Properties.Name -contains 'mcpServers')) {
    $existing | Add-Member -MemberType NoteProperty -Name 'mcpServers' -Value ([pscustomobject]@{})
}
$entry = [pscustomobject]@{ type = 'http'; url = $mcpUrl }
if ($existing.mcpServers.PSObject.Properties.Name -contains 'api-override') {
    $existing.mcpServers.'api-override' = $entry
    Write-Ok "更新已有 'api-override' 配置 → $mcpUrl"
} else {
    $existing.mcpServers | Add-Member -MemberType NoteProperty -Name 'api-override' -Value $entry
    Write-Ok "添加 'api-override' 配置 → $mcpUrl"
}
$json = $existing | ConvertTo-Json -Depth 32
[System.IO.File]::WriteAllText($claudeConfig, $json, [System.Text.UTF8Encoding]::new($false))
Write-Ok "已写入 $claudeConfig"

# 3. 写启动器（run-server.cmd + .vbs）
if (-not $NoAutostart) {
    Write-Step "注册开机自启"
    $logDir = Split-Path -Parent $logFile
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    $nodeExe = (Get-Command node).Source
    $cmdContent = "@echo off`r`nsetlocal`r`nset API_OVERRIDE_PORT=$Port`r`nset API_OVERRIDE_HOST=$BindHost`r`n`"$nodeExe`" `"$indexJs`" >> `"$logFile`" 2>&1`r`n"
    [System.IO.File]::WriteAllText($runCmd, $cmdContent, [System.Text.Encoding]::ASCII)
    $vbsContent = "' Auto-generated by api-override-mcp install.ps1 — silently launches run-server.cmd at login.`r`nSet sh = CreateObject(`"WScript.Shell`")`r`nsh.Run Chr(34) & `"$runCmd`" & Chr(34), 0, False`r`n"
    [System.IO.File]::WriteAllText($shimVbs, $vbsContent, [System.Text.Encoding]::ASCII)
    Write-Ok "已写入启动器: $runCmd"
    Write-Ok "已写入启动项: $shimVbs"
    Write-Host "        日志位置: $logFile"
}

# 4. 立即启动
if (-not $NoStart) {
    Write-Step "启动 mcp-server"
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
        Start-Process 'wscript.exe' -ArgumentList "`"$shimVbs`""
        Write-Ok "已通过启动项静默启动（无窗口，输出写到 $logFile）"
    } else {
        Start-Process 'cmd.exe' -ArgumentList '/k', "`"$runCmd`""
        Write-Ok "已在新窗口启动（前台）"
    }
    $ok = $false
    foreach ($wait in 2, 2, 3) {
        Start-Sleep -Seconds $wait
        try {
            $resp = Invoke-RestMethod -Uri "http://$BindHost`:$Port/status" -TimeoutSec 3 -ErrorAction Stop
            if ($resp.ok) { Write-Ok "Server 健康检查通过：extensionConnected=$($resp.extensionConnected)"; $ok = $true; break }
        } catch { }
    }
    if (-not $ok) { Write-Warn2 "健康检查超时，看日志: $logFile" }
}

# 5. 引导加载扩展
$extPath = Join-Path $repoRoot 'extension'
Write-Host ""
Write-Host "===========================================" -ForegroundColor Green
Write-Host " 安装完成！" -ForegroundColor Green
Write-Host "===========================================" -ForegroundColor Green
Write-Host ""
Write-Host "接下来要做的最后一件事：在 Chrome 加载扩展"
Write-Host "  1. 打开 chrome://extensions"
Write-Host "  2. 开启 [开发者模式]"
Write-Host "  3. 点 [加载已解压的扩展程序] -> 选目录:"
Write-Host "     $extPath" -ForegroundColor Yellow
try { $extPath | Set-Clipboard; Write-Host "  （路径已复制到剪贴板）" -ForegroundColor DarkGray } catch {}
try { Start-Process 'chrome' -ArgumentList 'chrome://extensions' -ErrorAction SilentlyContinue } catch {}
Write-Host ""
Write-Host "卸载: 在本目录运行 .\\uninstall.ps1"
Write-Host ""
`;
  DEAD_CODE_END */

  // uninstall.ps1 — same as source repo's
  const uninstallPs1Source = await readFile(resolve(ROOT, 'uninstall.ps1'), 'utf-8');

  await writeFile(resolve(STAGE, 'install.ps1'), installPs1, 'utf-8');
  await writeFile(resolve(STAGE, 'uninstall.ps1'), uninstallPs1Source, 'utf-8');

  // README for the release zip
  const readme = `﻿# API Override MCP（发行包）

源码已打包并混淆。使用方法：

## 一行安装

打开 PowerShell 跑：

    irm https://raw.githubusercontent.com/hanzhipeng0903/override-mcp/main/bootstrap.ps1 | iex

或解压本 zip 后：

    powershell -ExecutionPolicy Bypass -File install.ps1

## 卸载

    powershell -ExecutionPolicy Bypass -File uninstall.ps1

## 需要

Node.js >= 18 (https://nodejs.org/zh-cn/)
`;
  await writeFile(resolve(STAGE, 'README.txt'), readme, 'utf-8');
  log('  → install.ps1 / uninstall.ps1 / README.txt');
}

async function makeZip() {
  log(`zip → ${RELEASE_ZIP}`);
  await new Promise((resolveZ, rejectZ) => {
    const out = createWriteStream(RELEASE_ZIP);
    const arc = archiver('zip', { zlib: { level: 9 } });
    out.on('close', resolveZ);
    arc.on('error', rejectZ);
    arc.pipe(out);
    arc.directory(STAGE, false); // contents at zip root, not inside override-mcp-release/
    arc.finalize();
  });
  const sz = (await stat(RELEASE_ZIP)).size;
  log(`  → ${(sz / 1024).toFixed(1)} KB`);
}

// ---- main ----
await clean();
await buildServer();
await buildExtension();
await emitInstallScripts();
await makeZip();
log('done.');
