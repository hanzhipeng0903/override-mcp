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
└── mcp-server/         ← run with `node index.js` (or via your MCP host)
    ├── package.json
    ├── index.js        ← MCP stdio entry
    ├── bridge.js       ← WS server (port 9876)
    └── tools.js        ← MCP tool definitions
```

## Setup

### 1. Install MCP server deps

```powershell
cd mcp-server
npm install
```

### 2. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** → pick the `extension/` folder
4. Pin the extension; the popup shows bridge status

### 3. Wire up the MCP server in your client

For Claude Code (`~/.claude.json` or per-project `.mcp.json`):

```json
{
  "mcpServers": {
    "api-override": {
      "command": "node",
      "args": ["C:\\Users\\hanzhipeng\\Desktop\\api-override-mcp\\mcp-server\\index.js"]
    }
  }
}
```

For Claude Desktop, add the same to its `claude_desktop_config.json`.

The server starts the WebSocket bridge on `ws://127.0.0.1:9876`. The extension
auto-reconnects every 2s, so order of startup doesn't matter.

## Quick start (smoke test)

1. Open the extension popup → click **Attach to active tab**
   (yellow "extension is debugging" banner appears — expected)
2. From Claude:
   - "Show me the last 20 requests this page made"  →  `tail_requests`
   - "Mock `/api/me` to return `{vip:true}`"        →  `add_rule` with `fulfill`
   - "Patch the user response so role=admin"        →  `add_rule` with `passthrough_patch`+`merge`
3. Refresh the page; intercepted requests now return your mock.

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
    type: 'fulfill',           // OR 'passthrough_patch' OR 'block'
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: '{"id":1,"name":"mock"}'
  },
  delay: 0,                    // optional ms delay
  times: -1                    // -1 unlimited; auto-disables after N hits
}
```

`passthrough_patch` example (changes one field on the real response):

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

- `API_OVERRIDE_PORT` (env, default `9876`) — bridge port
- `API_OVERRIDE_HOST` (env, default `127.0.0.1`) — bridge bind host

If you change the port, also update `WS_URL` in `extension/background.js`.
