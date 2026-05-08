@echo off
REM ============================================================
REM  API Override MCP - 一键启动 (前台、有窗口)
REM  双击这个文件即可在新窗口里跑 server。关掉窗口就停。
REM
REM  想要安装到开机自启 / 写入 Claude Code 配置：跑 install.ps1
REM ============================================================

setlocal
cd /d "%~dp0\mcp-server"

REM 检查 node
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo [X] 未找到 node 命令，请先安装 Node.js (^>=18): https://nodejs.org/zh-cn/
    echo.
    pause
    exit /b 1
)

REM 首次跑自动 npm install
if not exist node_modules (
    echo.
    echo ==^> 首次启动，正在安装依赖...
    call npm install
    if errorlevel 1 (
        echo [X] npm install 失败
        pause
        exit /b 1
    )
)

echo.
echo ==^> 启动 api-override-mcp ...
echo     关闭此窗口即可停止 server
echo.

node index.js

REM 异常退出时保留窗口
if errorlevel 1 pause
