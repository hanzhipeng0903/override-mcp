#!/usr/bin/env node
// api-override MCP server entry point.
//
// Hosts a long-lived HTTP server on $API_OVERRIDE_PORT (default 9876) that exposes:
//   - GET/POST /mcp     : MCP Streamable HTTP transport (consumed by Claude Code etc.)
//   - POST    /call     : tiny REST admin endpoint (PowerShell/curl-friendly)
//   - GET     /status   : health check
//   - WS      /         : WebSocket for the browser extension
//
// We deliberately do NOT register a stdio transport — Claude Code (Bun runtime) has a
// segfault bug when spawning a Node child for stdio MCP. Using HTTP transport means
// Claude Code never spawns this process; it just sends HTTP requests.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { randomUUID } from 'node:crypto';

import { ExtensionBridge } from './bridge.js';
import { buildTools } from './tools.js';

const PORT = Number(process.env.API_OVERRIDE_PORT || 9876);
const HOST = process.env.API_OVERRIDE_HOST || '127.0.0.1';

// ---- bridge (extension WS + /call admin) ----
const bridge = new ExtensionBridge({ port: PORT, host: HOST });

// ---- MCP server + HTTP transport ----
function createMcpServer() {
  const tools = buildTools(bridge);
  const server = new Server(
    { name: 'api-override-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema)
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find(t => t.name === req.params.name);
    if (!tool) {
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }] };
    }
    try {
      const args = tool.inputSchema.parse(req.params.arguments || {});
      const result = await tool.handler(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: String(e?.message || e) }] };
    }
  });

  return server;
}

// Stateful Streamable HTTP: one transport per MCP session.
// Client (Claude Code) sends `initialize` without a session header; we generate a
// session id, return it in the `Mcp-Session-Id` response header, and the client
// includes it on all subsequent requests until DELETE closes the session.
const sessions = new Map(); // sessionId -> transport

async function handleMcpRequest(req, res, body) {
  const headerSid = req.headers['mcp-session-id'];
  const sessionId = Array.isArray(headerSid) ? headerSid[0] : headerSid;
  let transport = sessionId ? sessions.get(sessionId) : undefined;

  if (!transport) {
    // No existing session: only allow this for an `initialize` request.
    if (req.method !== 'POST' || !isInitializeRequest(body)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'No session: send `initialize` first' }
      }));
    }
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => sessions.set(sid, transport)
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const server = createMcpServer();
    await server.connect(transport);
  }
  return transport.handleRequest(req, res, body);
}

bridge.setMcpHandler(handleMcpRequest);

bridge.onEvent((event, data) => {
  console.error('[ext-event]', event, JSON.stringify(data));
});

try {
  await bridge.start();
} catch (err) {
  // Friendly error already printed inside bridge.start(). Bail out.
  process.exit(1);
}

console.error('');
console.error(`✓ api-override-mcp 就绪`);
console.error(`  MCP HTTP  : http://${HOST}:${PORT}/mcp     ← Claude Code 用这个`);
console.error(`  REST 调试 : http://${HOST}:${PORT}/call    ← curl/PowerShell 调试用`);
console.error(`  扩展连接  : ws://${HOST}:${PORT}            ← 浏览器扩展自动连`);
console.error('');
console.error('下一步：');
console.error('  • 在 Chrome 加载 extension/ 目录（chrome://extensions → 开发者模式 → 加载已解压）');
console.error('  • 在 Claude Code 配置：');
console.error(`      "api-override": { "type": "http", "url": "http://${HOST}:${PORT}/mcp" }`);
console.error('');

// Graceful shutdown — Ctrl+C should release the port immediately
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.error(`\n收到 ${sig}，正在关闭...`);
    process.exit(0);
  });
}
