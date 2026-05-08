// WebSocket server: hosts a single connection from the browser extension and
// proxies request/response messages between MCP tool calls and the extension.
// Also exposes a small HTTP admin endpoint on the same port for quick CLI-driven
// invocation of methods (POST /call {method, params}).

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

export class ExtensionBridge {
  constructor({ port = 9876, host = '127.0.0.1' } = {}) {
    this.port = port;
    this.host = host;
    this.client = null;             // current extension websocket
    this.pending = new Map();       // id -> { resolve, reject, timer }
    this.eventListeners = new Set();
    this._mcpHandler = null;        // (req, res, body?) => void; set via setMcpHandler
  }

  /**
   * Register a handler for /mcp* requests. The handler receives the raw Node
   * IncomingMessage/ServerResponse plus a parsed JSON body (or undefined).
   * The MCP SDK's StreamableHTTPServerTransport.handleRequest fits this shape.
   */
  setMcpHandler(fn) {
    this._mcpHandler = fn;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => this._handleHttp(req, res));
      this.wss = new WebSocketServer({ server: this.httpServer });
      this.wss.on('connection', (ws) => {
        // Replace any prior client (extension reload, etc.)
        if (this.client && this.client.readyState === this.client.OPEN) {
          try { this.client.close(); } catch {}
        }
        this.client = ws;
        this.log('✓ extension connected');
        if (this._noExtensionWarn) {
          clearTimeout(this._noExtensionWarn);
          this._noExtensionWarn = null;
        }
        ws.on('message', (data) => this._onMessage(data));
        ws.on('close', () => {
          if (this.client === ws) this.client = null;
          this.log('extension disconnected');
        });
        ws.on('error', (e) => this.log('ws error:', e.message));
      });

      this.httpServer.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.error('');
          console.error(`✗ 端口 ${this.port} 已被占用。`);
          console.error('  排查办法：');
          console.error(`    PowerShell:  Get-NetTCPConnection -LocalPort ${this.port} | Select-Object OwningProcess`);
          console.error(`    然后:        Stop-Process -Id <PID>`);
          console.error('  或换端口：set $env:API_OVERRIDE_PORT=9877; node index.js');
          console.error('');
        } else {
          console.error(`✗ bridge 启动失败: ${err.message}`);
        }
        reject(err);
      });

      this.httpServer.listen(this.port, this.host, () => {
        this.log(`bridge listening on http://${this.host}:${this.port}`);
        this.log(`  MCP   : /mcp   (Streamable HTTP transport)`);
        this.log(`  REST  : /call  (POST {method, params})`);
        this.log(`  WS    : /      (browser extension)`);

        // If no extension connects within 30s, give a hint about loading it.
        this._noExtensionWarn = setTimeout(() => {
          if (!this.isConnected()) {
            console.error('');
            console.error('⚠ 30 秒内未检测到浏览器扩展连接。检查：');
            console.error('  1. Chrome → chrome://extensions 是否已加载 extension/ 目录');
            console.error('  2. 扩展 popup 里"桥接服务地址"是否指向本机和正确端口');
            console.error(`  3. 当前监听: ws://${this.host}:${this.port}`);
            console.error('');
          }
        }, 30000);

        resolve();
      });
    });
  }

  _handleHttp(req, res) {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    const url = (req.url || '').split('?')[0];

    // ---- MCP Streamable HTTP transport ----
    if (this._mcpHandler && (url === '/mcp' || url.startsWith('/mcp/'))) {
      // POST/DELETE carry a body, GET (SSE) doesn't.
      if (req.method === 'GET' || req.method === 'DELETE') {
        try { return this._mcpHandler(req, res); }
        catch (e) { return send(500, { error: String(e?.message || e) }); }
      }
      let raw = '';
      req.on('data', (c) => raw += c);
      req.on('end', () => {
        let body;
        try { body = raw ? JSON.parse(raw) : undefined; }
        catch { return send(400, { error: 'invalid JSON body' }); }
        try { this._mcpHandler(req, res, body); }
        catch (e) { send(500, { error: String(e?.message || e) }); }
      });
      req.on('error', () => send(400, { error: 'request error' }));
      return;
    }

    // ---- Health check ----
    if (req.method === 'GET' && (url === '/' || url === '/status')) {
      return send(200, {
        ok: true,
        extensionConnected: this.isConnected(),
        port: this.port,
        mcp: !!this._mcpHandler
      });
    }

    // ---- Tiny REST admin: POST /call {method, params} ----
    if (req.method === 'POST' && url === '/call') {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', async () => {
        try {
          const { method, params } = JSON.parse(body || '{}');
          if (!method) return send(400, { error: 'method required' });
          const result = await this.call(method, params || {});
          send(200, { result });
        } catch (e) {
          send(400, { error: String(e?.message || e) });
        }
      });
      return;
    }

    send(404, { error: 'not found', tried: url });
  }

  isConnected() {
    return !!this.client && this.client.readyState === this.client.OPEN;
  }

  onEvent(fn) {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  /**
   * Send a request to the extension and await its response.
   */
  async call(method, params = {}, { timeoutMs = 15000 } = {}) {
    if (!this.isConnected()) {
      throw new Error('extension not connected — load the extension in Chrome and make sure ws://localhost:' + this.port + ' is reachable');
    }
    const id = randomUUID();
    const payload = JSON.stringify({ id, type: 'request', method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`extension call timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.client.send(payload);
    });
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'response') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
      return;
    }

    if (msg.type === 'event') {
      for (const fn of this.eventListeners) {
        try { fn(msg.event, msg.data); } catch (e) { this.log('event listener error:', e.message); }
      }
    }
  }

  log(...args) { console.error('[bridge]', ...args); }
}
