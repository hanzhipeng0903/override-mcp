# API Override (MCP-controlled)

A Chrome extension + MCP server pair that lets an AI (or you) intercept and
override HTTP responses in any browser tab — including responses that would
otherwise return 404, 5xx, or fail at the network layer entirely.

```
┌──────────────┐    stdio    ┌──────────────┐    WebSocket    ┌────────────────┐    CDP    ┌──────────┐
│ Claude Code  │ ──────────► │  MCP server  │ ◄────────────► │  Extension SW  │ ────────► │ Browser  │
└──────────────┘             │  (Node.js)   │   ws://9876    │ chrome.debugger│           │   tab    │
                             └──────────────┘                 └────────────────┘           └──────────┘
```

## Why

- Mock 404 / not-yet-built endpoints without touching backend
- Force success/failure cases for QA (`{vip:true}`, empty arrays, errors)
- Patch a real response with one field changed (`passthrough_patch`)
- Drive all of the above from natural-language prompts via MCP

## Layout

```
api-override-mcp/
├── extension/          ← load this unpacked in Chrome (chrome://extensions)
│   ├── manifest.json
│   ├── background.js   ← service worker: WS client + chrome.debugger
│   ├── popup.html / popup.js
│   └── icons/
├── mcp-server/         ← long-running HTTP MCP server
│   ├── index.js        ← entry (HTTP transport, port 9876)
│   ├── bridge.js       ← WS bridge to extension + REST /call admin
│   └── tools.js        ← MCP tool definitions
├── install.ps1         ← one-click installer (Windows)
├── uninstall.ps1       ← undo installer
└── start.bat           ← double-click to run server in foreground
```

## 安装（一行命令）

> Windows only。需要 Node.js >= 18（[下载](https://nodejs.org/zh-cn/)）。

打开 PowerShell，运行：

```powershell
irm https://raw.githubusercontent.com/hanzhipeng0903/override-mcp/main/bootstrap.ps1 | iex
```

这一行会做完所有事：

1. 把仓库下到 `%LOCALAPPDATA%\override-mcp`（有 git 用 `git clone`，没 git 用 zip 下载）
2. `npm install`
3. 把 MCP 配置写入 `~/.claude.json`（HTTP transport）
4. 注册到 Windows 启动文件夹（开机静默自启，无控制台窗口）
5. 立即启动 server 并探活
6. 把扩展目录路径**自动复制到剪贴板**，并尝试打开 `chrome://extensions`

跑完之后只剩**最后一步要手动**（Manifest V3 的硬限制，不能脚本化）：

> Chrome → `chrome://extensions` → 开 [开发者模式] → [加载已解压的扩展程序] → 粘贴剪贴板里的路径

popup 顶部出现绿色 `connected` 就大功告成。然后**重启 Claude Code**，让 AI 直接对网页发命令。

### 一行命令的可选参数

```powershell
# 换端口
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/hanzhipeng0903/override-mcp/main/bootstrap.ps1))) -Port 9999

# 装到自定义目录
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/hanzhipeng0903/override-mcp/main/bootstrap.ps1))) -InstallDir D:\tools\override-mcp

# 不开机自启
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/hanzhipeng0903/override-mcp/main/bootstrap.ps1))) -NoAutostart
```

### 更新到最新版

再跑一遍上面那行命令即可。bootstrap 脚本会自动 `git pull`（或重新下 zip）并重新 install。

### 卸载

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\override-mcp\uninstall.ps1"
```

扩展需要手动在 `chrome://extensions` 移除。

---

## 离线 / 手动安装（不想跑在线脚本）

```powershell
git clone https://github.com/hanzhipeng0903/override-mcp.git
cd override-mcp
.\install.ps1
```

或下载 zip → 解压 → 进目录跑 `.\install.ps1`。完全不想用 PowerShell 的话，双击 `start.bat` 也能临时把 server 跑起来（不写自启）。

> ⚠️ 不要再用旧的 stdio 配置（`"command": "node", "args": [...]`）。
> Claude Code 的 Bun runtime 在 spawn Node 子进程跑 stdio MCP 时存在 segfault，
> 现在 server 走的是 HTTP transport。

## Quick start

装完之后**不需要点 popup 的 Attach 按钮**，直接在 Claude 里发命令即可：

| 你说 | Claude 调用 | 实际发生 |
|---|---|---|
| "show me what this page just requested" | `active_context` | 自动 attach 当前 tab → 返回最近 N 条请求 |
| "mock `/api/me` to return `{vip:true}`" | `add_rule` (fulfill) | 自动 attach + 添加规则，刷新页面立即生效 |
| "patch the user response so role=admin" | `add_rule` (passthrough_patch+merge) | 同上 |
| "block all ads requests" | `add_rule` (block) | 同上 |

第一次 attach 会出现黄色 **"extension is debugging this browser"** 横幅 —— 这是 Chrome 的硬要求，不可关闭。
功能用完想去掉横幅，让 AI 调 `detach` 或在 popup 点 Detach。

## Tools (MCP surface)

| Tool                | Purpose                                                       |
| ------------------- | ------------------------------------------------------------- |
| `status`            | Connection / enabled / counts                                 |
| `list_tabs`         | Pick a tab to attach to                                       |
| `attach`            | Begin intercepting on a tab                                   |
| `attach_active`     | Attach to current active tab                                  |
| `detach`            | Stop intercepting + remove banner                             |
| `enable` / `disable`| Global override on/off                                        |
| `list_rules`        | Show all rules                                                |
| `add_rule`          | Add a rule (`fulfill` / `passthrough_patch` / `block`)        |
| `update_rule`       | Patch an existing rule by id                                  |
| `remove_rule`       | Delete a rule                                                 |
| `clear_rules`       | Wipe all rules                                                |
| `tail_requests`     | Show recent N requests (URL / status / body preview)          |
| `get_request`       | Full request+response detail                                  |
| `mock_from_request` | Build a fulfill rule from a real captured response, with optional deep-merge patch |

## Rule shape

```js
{
  match: { url: '*api/users*', method: 'GET' },  // glob or /regex/
  action: {
    type: 'fulfill',           // fulfill | passthrough_patch | passthrough_text_patch | redirect | block
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: '{"id":1,"name":"mock"}'
  },
  delay: 0,                    // optional ms delay
  times: -1                    // -1 unlimited; auto-disables after N hits
}
```

`passthrough_patch` example (changes one field on the real JSON response):

```js
{
  match: { url: '*api/me' },
  action: {
    type: 'passthrough_patch',
    merge: { user: { role: 'admin' } }
    // or jsonPatch: [{op:'replace', path:'/user/role', value:'admin'}]
  }
}
```

`passthrough_text_patch` example (string/regex replace on the real response body — works for HTML, JS, CSS, anything text):

```js
{
  match: { url: 'https://example.com/' },
  action: {
    type: 'passthrough_text_patch',
    replace: [
      { from: '</head>', to: '<script src="http://127.0.0.1:5173/inject.js"></script></head>' },
      // regex form:
      { from: 'window\\.__FLAG__\\s*=\\s*false', to: 'window.__FLAG__ = true', regex: true }
    ],
    // strip CSP so injected scripts can actually run
    stripHeaders: ['content-security-policy', 'content-security-policy-report-only']
  }
}
```

`redirect` example (point prod assets at a local dev server):

```js
{
  match: { url: 'https://prod.example.com/static/*' },
  action: {
    type: 'redirect',
    rewrite: {
      from: 'https://prod.example.com/static/',
      to:   'http://127.0.0.1:5173/src/'
    }
    // or replace the entire URL:
    // url: 'http://127.0.0.1:5173/src/index.js'
  }
}
```

> ⚠ Cross-origin redirect targets need to serve the right CORS headers for `fetch`/XHR.
> `<script src>` / `<link href>` / `<img>` etc. don't go through CORS unless the tag has `crossorigin`,
> so most "prod → localhost dev server" rewrites for static assets work out of the box.

`block` example (simulate network failures):

```js
{
  match: { url: '*ads*' },
  action: { type: 'block', reason: 'ConnectionRefused' }
  // reason: Failed | Aborted | TimedOut | AccessDenied | ConnectionRefused | ...
}
```

## Known limitations

- The yellow **"extension is debugging this browser"** banner is unavoidable;
  it's how Chrome tells the user the debugger API is in use. This is the price
  of being able to fully replace response bodies.
- DevTools (F12) and this extension can't both attach to the same tab. If you
  open DevTools while attached, you'll see a CDP-conflict error. Detach first.
- Service Worker and dedicated worker requests are not yet attached separately
  — only the page target. Add a per-target attach in `attachTab` if needed.
- CSP-blocked requests and chrome:// internals can't be intercepted.

## Configuration

| 项 | 说明 |
| --- | --- |
| `API_OVERRIDE_PORT` (env, 默认 `9876`) | bridge 监听端口 |
| `API_OVERRIDE_HOST` (env, 默认 `127.0.0.1`) | bridge 绑定 host |
| 扩展端的桥接地址 | popup → 设置 → "桥接服务地址"，改了会立即重连 |

> 改 server 端口 → 用上面的环境变量启动；扩展端在 popup 里同步改成相同端口即可，
> **不需要改源码**。`install.ps1 -Port 9999` 会一次性把两端都对齐（启动项 + Claude Code 配置），
> 但扩展那边仍然要打开 popup 改一下端口。
