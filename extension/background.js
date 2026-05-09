// ============================================================
// API Override — Extension Service Worker
// ============================================================
// Connects to an MCP-controlled WebSocket bridge, attaches the
// chrome.debugger to user-selected tabs, and intercepts/overrides
// HTTP responses via the CDP Fetch domain.
// ============================================================

const DEFAULT_BRIDGE_PORT = 9876;
const DEFAULT_BRIDGE_HOST = 'localhost';
const MAX_RECENT = 200;

const state = {
  ws: null,
  reconnectTimer: null,
  attachedTabs: new Set(),       // Set<tabId>
  rules: [],                     // Rule[]
  enabled: true,
  recent: [],                    // RingBuffer of {id, tabId, url, method, status, reqHeaders, resHeaders, resBody, ts}
  pendingResponseBodies: new Map(), // requestId -> {body, base64Encoded} cache (best-effort)
  autoAttachHosts: [],           // hostname glob patterns ('*.example.com', 'foo.bar')
  autoAttachEnabled: true,       // master switch for the auto-attach feature
  bridgeHost: DEFAULT_BRIDGE_HOST,
  bridgePort: DEFAULT_BRIDGE_PORT
};

function bridgeUrl() {
  return `ws://${state.bridgeHost}:${state.bridgePort}`;
}

// ------------------------------------------------------------
// Boot
// ------------------------------------------------------------
chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);
boot();

async function boot() {
  const data = await chrome.storage.local.get([
    'rules', 'enabled', 'autoAttachHosts', 'autoAttachEnabled',
    'bridgeHost', 'bridgePort'
  ]);
  state.rules = data.rules || [];
  state.enabled = data.enabled !== false;
  state.autoAttachHosts = Array.isArray(data.autoAttachHosts) ? data.autoAttachHosts : [];
  state.autoAttachEnabled = data.autoAttachEnabled !== false;
  state.bridgeHost = data.bridgeHost || DEFAULT_BRIDGE_HOST;
  state.bridgePort = Number(data.bridgePort) || DEFAULT_BRIDGE_PORT;
  connect();
  // On boot, sweep existing tabs against the whitelist
  sweepAutoAttach().catch((e) => log('initial sweep failed', e?.message));
}

async function setBridgeAddress(host, port) {
  const newHost = (host || DEFAULT_BRIDGE_HOST).trim() || DEFAULT_BRIDGE_HOST;
  const newPort = Number(port) || DEFAULT_BRIDGE_PORT;
  if (newPort < 1 || newPort > 65535) throw new Error(`invalid port: ${port}`);
  state.bridgeHost = newHost;
  state.bridgePort = newPort;
  await chrome.storage.local.set({ bridgeHost: newHost, bridgePort: newPort });
  // Force-reconnect to the new address
  try { state.ws?.close(); } catch {}
  state.ws = null;
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  connect();
  return getBridgeAddress();
}

function getBridgeAddress() {
  return {
    host: state.bridgeHost,
    port: state.bridgePort,
    url: bridgeUrl(),
    connected: state.ws?.readyState === WebSocket.OPEN
  };
}

async function sweepAutoAttach() {
  if (!state.autoAttachEnabled || !state.autoAttachHosts.length) return;
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!t.url || state.attachedTabs.has(t.id)) continue;
    if (hostMatches(t.url, state.autoAttachHosts)) {
      try { await attachTab(t.id); } catch (e) { log('sweep auto-attach failed', t.id, e?.message); }
    }
  }
}

function hostMatches(url, patterns) {
  let host;
  try { host = new URL(url).hostname; } catch { return false; }
  return patterns.some(p => globMatch(host, p));
}

// Keep service worker warm-ish + auto-reconnect
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name === 'keepalive') {
    if (!state.ws || state.ws.readyState === WebSocket.CLOSED) connect();
  }
});

// Detached automatically by Chrome when tab closes
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId) {
    state.attachedTabs.delete(source.tabId);
    log(`debugger detached from tab ${source.tabId}: ${reason}`);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  state.attachedTabs.delete(tabId);
});

// Auto-attach by host whitelist: when a tab navigates into a matching host,
// attach silently. Idempotent — attachTab is a no-op when already attached.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!state.autoAttachEnabled) return;
  if (!state.autoAttachHosts.length) return;
  if (state.attachedTabs.has(tabId)) return;
  if (info.status !== 'loading' && info.status !== 'complete') return;
  if (!tab?.url) return;
  if (!hostMatches(tab.url, state.autoAttachHosts)) return;
  try { await attachTab(tabId); }
  catch (e) { log('auto-attach failed', tabId, e?.message); }
});

// Popup → background bridge (reuses the same dispatch table)
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.__popup) return false;
  (async () => {
    try {
      let result;
      if (msg.method === 'status') {
        result = { ...status(), wsConnected: state.ws?.readyState === WebSocket.OPEN };
      } else {
        result = await dispatch(msg.method, msg.params || {});
      }
      sendResponse(result);
    } catch (e) {
      sendResponse({ error: String(e?.message || e) });
    }
  })();
  return true; // async
});

// ------------------------------------------------------------
// WebSocket bridge
// ------------------------------------------------------------
function connect() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  try {
    state.ws = new WebSocket(bridgeUrl());
  } catch (e) {
    log('ws construct error', e);
    scheduleReconnect();
    return;
  }
  state.ws.onopen = () => {
    log('ws connected');
    sendEvent('hello', { version: '0.1.0', attachedTabs: [...state.attachedTabs] });
  };
  state.ws.onclose = () => {
    log('ws closed');
    scheduleReconnect();
  };
  state.ws.onerror = () => { /* swallow; onclose follows */ };
  state.ws.onmessage = onWsMessage;
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connect();
  }, 2000);
}

function sendEvent(event, data) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'event', event, data }));
  }
}

function sendResponse(id, result, error) {
  if (state.ws?.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({ id, type: 'response', result, error: error ?? null }));
}

async function onWsMessage(ev) {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.type !== 'request') return;
  try {
    const result = await dispatch(msg.method, msg.params || {});
    sendResponse(msg.id, result, null);
  } catch (e) {
    sendResponse(msg.id, null, String(e?.message || e));
  }
}

// ------------------------------------------------------------
// MCP method dispatch
// ------------------------------------------------------------
async function dispatch(method, params) {
  switch (method) {
    case 'status':            return status();
    case 'active_context':    return activeContext(params.n ?? 10, params.type);
    case 'list_tabs':         return listTabs();
    case 'attach':            return attachTab(await resolveTabId(params.tabId));
    case 'detach':            return detachTab(await resolveTabId(params.tabId));
    case 'attach_active':     return attachActive();

    case 'list_rules':        return state.rules;
    case 'add_rule':          return addRule(params.rule);
    case 'update_rule':       return updateRule(params.id, params.patch);
    case 'remove_rule':       return removeRule(params.id);
    case 'clear_rules':       return clearRules();

    case 'enable':            return setEnabled(true);
    case 'disable':           return setEnabled(false);

    case 'get_auto_attach':   return getAutoAttach();
    case 'set_auto_attach_enabled': return setAutoAttachEnabled(params.enabled);
    case 'add_auto_host':     return addAutoHost(params.pattern);
    case 'remove_auto_host':  return removeAutoHost(params.pattern);
    case 'clear_auto_hosts':  return clearAutoHosts();

    case 'get_bridge_address': return getBridgeAddress();
    case 'set_bridge_address': return setBridgeAddress(params.host, params.port);

    case 'tail_requests':     return tailRequests(params.n ?? 20, await resolveFilter(params.filter));
    case 'get_request':       return getRequest(params.reqId);
    case 'mock_from_request': return mockFromRequest(params.reqId, params.patch || {});

    default: throw new Error(`unknown method: ${method}`);
  }
}

// Resolve `tabId`: if undefined, fall back to the current active tab.
async function resolveTabId(tabId) {
  if (tabId != null) return tabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('no tabId given and no active tab found');
  return tab.id;
}

// If the caller passes filter:{tabId:'active'} or omits tabId entirely on a request
// for the active tab's traffic, resolve it. Filter is otherwise passed through.
async function resolveFilter(filter) {
  if (!filter) return filter;
  if (filter.tabId === 'active') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return { ...filter, tabId: tab?.id };
  }
  return filter;
}

// One-call snapshot of "the page the user is currently looking at" — the most
// useful thing to feed Claude when the user references "this page" / "the
// current tab" / etc. Returns active tab info, attach state, and recent traffic
// scoped to that tab.
async function activeContext(n, type) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { active: null, recent: [] };
  // If the active tab isn't attached yet, attach it now so subsequent calls
  // (and any add_rule the AI is about to issue) actually capture traffic.
  // Skip non-http URLs — chrome.debugger can't attach to chrome:// pages.
  if (!state.attachedTabs.has(tab.id) && /^https?:/.test(tab.url || '')) {
    try { await attachTab(tab.id); }
    catch (e) { log('active_context auto-attach failed:', e?.message); }
  }
  const recent = state.recent
    .filter(r => r.tabId === tab.id)
    .filter(r => matchType(r.type, type))
    .slice(-n)
    .map(r => ({
      id: r.id, url: r.url, method: r.method, status: r.status,
      type: r.type, ts: r.ts, mimeType: r.mimeType,
      bodyAvailable: r.resBody != null && r.resBody !== '[binary]',
      bodyPreview: previewBody(r.resBody),
      overridden: !!r.overridden, overrideRuleId: r.overrideRuleId || null
    }));
  return {
    active: {
      id: tab.id,
      url: tab.url,
      title: tab.title,
      attached: state.attachedTabs.has(tab.id)
    },
    enabled: state.enabled,
    ruleCount: state.rules.length,
    typeFilter: type ?? null,
    recent
  };
}

// matchType returns true if `actual` (a CDP ResourceType, e.g. 'XHR', 'Fetch',
// 'Stylesheet') matches the requested filter. Filter forms:
//   - undefined / null / 'all' → match everything
//   - 'api'                    → match XHR or Fetch (the most common ask)
//   - 'XHR' / 'Fetch' / ...    → exact CDP type name (case-insensitive)
//   - array of any of the above → OR'd together
function matchType(actual, filter) {
  if (!filter || filter === 'all') return true;
  const arr = Array.isArray(filter) ? filter : [filter];
  const expanded = arr.flatMap(t => t === 'api' ? ['XHR', 'Fetch'] : [t]);
  const want = expanded.map(t => String(t).toLowerCase());
  return want.includes(String(actual || '').toLowerCase());
}

function status() {
  return {
    enabled: state.enabled,
    attachedTabs: [...state.attachedTabs],
    ruleCount: state.rules.length,
    recentCount: state.recent.length
  };
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map(t => ({
    id: t.id,
    url: t.url,
    title: t.title,
    active: t.active,
    windowId: t.windowId,
    attached: state.attachedTabs.has(t.id)
  }));
}

async function attachActive() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('no active tab');
  return attachTab(tab.id);
}

async function attachTab(tabId) {
  if (!tabId) throw new Error('tabId required');
  if (state.attachedTabs.has(tabId)) return { ok: true, already: true };

  await chrome.debugger.attach({ tabId }, '1.3');
  await reconfigureFetch(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
  state.attachedTabs.add(tabId);
  return { ok: true };
}

async function detachTab(tabId) {
  if (!state.attachedTabs.has(tabId)) return { ok: true, already: true };
  try { await chrome.debugger.detach({ tabId }); } catch {}
  state.attachedTabs.delete(tabId);
  return { ok: true };
}

// Configure CDP Fetch stages based on rules in play.
// - Response-stage actions (passthrough_patch / passthrough_text_patch) need Response stage.
// - Otherwise: just Request stage (cheaper).
async function reconfigureFetch(tabId) {
  const needsResponseStage = state.rules.some(r =>
    r.enabled !== false &&
    (r.action?.type === 'passthrough_patch' || r.action?.type === 'passthrough_text_patch')
  );
  const patterns = [{ urlPattern: '*', requestStage: 'Request' }];
  if (needsResponseStage) patterns.push({ urlPattern: '*', requestStage: 'Response' });
  await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', { patterns });
}

async function reconfigureAllAttached() {
  for (const tabId of state.attachedTabs) {
    try { await reconfigureFetch(tabId); } catch (e) { log('reconfigure failed', tabId, e); }
  }
}

// ------------------------------------------------------------
// Rule management
// ------------------------------------------------------------
async function addRule(rule) {
  const r = normalizeRule(rule);
  state.rules.push(r);
  await persistRules();
  // Make the rule effective immediately: if the user's active tab isn't
  // attached yet, attach it now so the rule fires without an extra step.
  // chrome.debugger can't attach to chrome:// internal pages — silently skip
  // those (the user can manually attach after navigating to a real page).
  await ensureActiveTabAttached();
  await reconfigureAllAttached();
  return r;
}

async function ensureActiveTabAttached() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;
    if (state.attachedTabs.has(tab.id)) return;
    if (!/^https?:/.test(tab.url || '')) return; // skip chrome://, file://, etc.
    await attachTab(tab.id);
    sendEvent('auto_attached', { tabId: tab.id, url: tab.url });
  } catch (e) {
    // Don't block rule creation on attach failure — user can attach manually
    log('auto-attach failed (rule still added):', e?.message);
  }
}

async function updateRule(id, patch) {
  const idx = state.rules.findIndex(r => r.id === id);
  if (idx < 0) throw new Error(`rule not found: ${id}`);
  state.rules[idx] = normalizeRule({ ...state.rules[idx], ...patch, id });
  await persistRules();
  await reconfigureAllAttached();
  return state.rules[idx];
}

async function removeRule(id) {
  const before = state.rules.length;
  state.rules = state.rules.filter(r => r.id !== id);
  await persistRules();
  await reconfigureAllAttached();
  return { removed: before - state.rules.length };
}

async function clearRules() {
  const n = state.rules.length;
  state.rules = [];
  await persistRules();
  await reconfigureAllAttached();
  return { removed: n };
}

async function setEnabled(v) {
  state.enabled = !!v;
  await chrome.storage.local.set({ enabled: state.enabled });
  return { enabled: state.enabled };
}

// ---- auto-attach by host whitelist ----

function getAutoAttach() {
  return { enabled: state.autoAttachEnabled, hosts: [...state.autoAttachHosts] };
}

async function setAutoAttachEnabled(v) {
  state.autoAttachEnabled = !!v;
  await chrome.storage.local.set({ autoAttachEnabled: state.autoAttachEnabled });
  if (state.autoAttachEnabled) sweepAutoAttach().catch(() => {});
  return getAutoAttach();
}

async function addAutoHost(pattern) {
  if (!pattern || typeof pattern !== 'string') throw new Error('pattern required');
  const p = pattern.trim();
  if (!p) throw new Error('pattern required');
  if (!state.autoAttachHosts.includes(p)) state.autoAttachHosts.push(p);
  await chrome.storage.local.set({ autoAttachHosts: state.autoAttachHosts });
  sweepAutoAttach().catch(() => {});
  return getAutoAttach();
}

async function removeAutoHost(pattern) {
  state.autoAttachHosts = state.autoAttachHosts.filter(p => p !== pattern);
  await chrome.storage.local.set({ autoAttachHosts: state.autoAttachHosts });
  return getAutoAttach();
}

async function clearAutoHosts() {
  state.autoAttachHosts = [];
  await chrome.storage.local.set({ autoAttachHosts: [] });
  return getAutoAttach();
}

async function persistRules() {
  await chrome.storage.local.set({ rules: state.rules });
}

function normalizeRule(rule) {
  const id = rule.id || crypto.randomUUID();
  return {
    id,
    enabled: rule.enabled !== false,
    note: rule.note || '',
    match: {
      url: rule.match?.url ?? '*',
      method: (rule.match?.method || '*').toUpperCase()
    },
    action: rule.action || { type: 'fulfill', status: 200, headers: {}, body: '' },
    delay: rule.delay || 0,
    times: rule.times ?? -1,
    hits: rule.hits || 0,
    createdAt: rule.createdAt || Date.now()
  };
}

// ------------------------------------------------------------
// CDP event handlers
// ------------------------------------------------------------
chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (!state.attachedTabs.has(source.tabId)) return;

  try {
    if (method === 'Fetch.requestPaused') {
      await onRequestPaused(source, params);
    } else if (method === 'Network.responseReceived') {
      onNetworkResponseReceived(source, params);
    } else if (method === 'Network.requestWillBeSent') {
      onNetworkRequestWillBeSent(source, params);
    } else if (method === 'Network.loadingFinished') {
      await onNetworkLoadingFinished(source, params);
    }
  } catch (e) {
    log('event handler error', method, e);
  }
});

async function onRequestPaused(source, p) {
  const { requestId, request, responseStatusCode, responseHeaders, networkId } = p;
  const isResponseStage = responseStatusCode !== undefined;

  if (!state.enabled) {
    return continueThrough(source, requestId, isResponseStage, responseHeaders);
  }

  const rule = findMatchingRule(request, isResponseStage);
  if (!rule) {
    return continueThrough(source, requestId, isResponseStage, responseHeaders);
  }

  // Optional artificial delay
  if (rule.delay > 0) await sleep(rule.delay);

  const action = rule.action;

  // ---- fulfill: short-circuit before hitting network ----
  if (action.type === 'fulfill') {
    const headers = toHeaderArray(action.headers || {});
    if (!headers.find(h => h.name.toLowerCase() === 'content-type') && action.body) {
      headers.push({ name: 'content-type', value: guessContentType(action.body) });
    }
    // Auto-add CORS headers when the request is cross-origin. Without these the
    // browser will block our mocked response from reaching the page's JS.
    addAutoCorsHeaders(headers, request);
    const status = action.status || 200;
    await chrome.debugger.sendCommand(source, 'Fetch.fulfillRequest', {
      requestId,
      responseCode: status,
      responseHeaders: headers,
      body: encodeBodyBase64(action.body || '')
    });
    bumpHit(rule);
    markOverridden(networkId, { status, body: action.body || '', ruleId: rule.id, kind: 'fulfill' });
    return;
  }

  // ---- redirect: rewrite the URL before the network request goes out ----
  if (action.type === 'redirect') {
    if (isResponseStage) return continueThrough(source, requestId, true, responseHeaders);
    let newUrl = request.url;
    if (action.rewrite && action.rewrite.from != null && action.rewrite.to != null) {
      newUrl = newUrl.split(action.rewrite.from).join(action.rewrite.to);
    } else if (action.url) {
      newUrl = action.url;
    }
    if (newUrl === request.url) {
      return continueThrough(source, requestId, false);
    }
    await chrome.debugger.sendCommand(source, 'Fetch.continueRequest', {
      requestId,
      url: newUrl
    });
    bumpHit(rule);
    markOverridden(networkId, {
      status: null,
      body: `[redirected → ${newUrl}]`,
      ruleId: rule.id,
      kind: 'redirect'
    });
    return;
  }

  // ---- block: simulate network failure ----
  if (action.type === 'block') {
    if (isResponseStage) return continueThrough(source, requestId, true, responseHeaders);
    await chrome.debugger.sendCommand(source, 'Fetch.failRequest', {
      requestId,
      errorReason: action.reason || 'Failed'
    });
    bumpHit(rule);
    markOverridden(networkId, { status: null, body: `[blocked: ${action.reason || 'Failed'}]`, ruleId: rule.id, kind: 'block' });
    return;
  }

  // ---- passthrough_patch: hit network, then patch JSON response ----
  if (action.type === 'passthrough_patch') {
    if (!isResponseStage) {
      // Let it through to response stage (we'll see it again).
      return chrome.debugger.sendCommand(source, 'Fetch.continueRequest', { requestId });
    }
    let raw;
    try {
      raw = await chrome.debugger.sendCommand(source, 'Fetch.getResponseBody', { requestId });
    } catch (e) {
      log('getResponseBody failed; passing through', e);
      return chrome.debugger.sendCommand(source, 'Fetch.continueResponse', { requestId });
    }
    const text = raw.base64Encoded ? safeAtob(raw.body) : raw.body;
    let json;
    try { json = JSON.parse(text); } catch {
      log('response not JSON; passing through');
      return chrome.debugger.sendCommand(source, 'Fetch.continueResponse', { requestId });
    }
    let patched = json;
    if (action.merge) patched = deepMerge(patched, action.merge);
    if (Array.isArray(action.jsonPatch)) patched = applyJsonPatch(patched, action.jsonPatch);

    const patchedJson = JSON.stringify(patched);
    await chrome.debugger.sendCommand(source, 'Fetch.fulfillRequest', {
      requestId,
      responseCode: action.status || responseStatusCode,
      responseHeaders: responseHeaders || [],
      body: encodeBodyBase64(patchedJson)
    });
    bumpHit(rule);
    markOverridden(networkId, {
      status: action.status || responseStatusCode,
      body: patchedJson,
      originalBody: text,
      ruleId: rule.id,
      kind: 'passthrough_patch'
    });
    return;
  }

  // ---- passthrough_text_patch: hit network, then string/regex-replace the body ----
  // Works for any text response (HTML, JS, CSS, plaintext) — does NOT require JSON.
  if (action.type === 'passthrough_text_patch') {
    if (!isResponseStage) {
      return chrome.debugger.sendCommand(source, 'Fetch.continueRequest', { requestId });
    }
    let raw;
    try {
      raw = await chrome.debugger.sendCommand(source, 'Fetch.getResponseBody', { requestId });
    } catch (e) {
      log('getResponseBody failed; passing through', e);
      return chrome.debugger.sendCommand(source, 'Fetch.continueResponse', { requestId });
    }
    const original = raw.base64Encoded ? safeAtob(raw.body) : raw.body;
    let text = original;
    if (Array.isArray(action.replace)) {
      for (const op of action.replace) {
        if (!op || op.from == null) continue;
        const to = op.to != null ? op.to : '';
        if (op.regex) {
          try {
            text = text.replace(new RegExp(op.from, op.flags || 'g'), to);
          } catch (e) {
            log('text_patch regex error; skipping op', e?.message);
          }
        } else {
          text = text.split(op.from).join(to);
        }
      }
    }
    // Optionally drop response headers (e.g. Content-Security-Policy) so injected
    // scripts can run. Compare case-insensitively.
    let headers = responseHeaders || [];
    if (Array.isArray(action.stripHeaders) && action.stripHeaders.length) {
      const drop = new Set(action.stripHeaders.map(s => String(s).toLowerCase()));
      headers = headers.filter(h => !drop.has(String(h.name).toLowerCase()));
    }
    await chrome.debugger.sendCommand(source, 'Fetch.fulfillRequest', {
      requestId,
      responseCode: action.status || responseStatusCode,
      responseHeaders: headers,
      body: encodeBodyBase64(text)
    });
    bumpHit(rule);
    markOverridden(networkId, {
      status: action.status || responseStatusCode,
      body: text,
      originalBody: original,
      ruleId: rule.id,
      kind: 'passthrough_text_patch'
    });
    return;
  }

  // Unknown action type — pass through
  return continueThrough(source, requestId, isResponseStage, responseHeaders);
}

// When an override actually fires, replace the recent log entry's resBody with
// what the page actually received, so tail_requests no longer shows the raw
// server response misleadingly.
function markOverridden(networkId, info) {
  if (!networkId) return;
  const item = state.recent.find(r => r.id === networkId);
  if (!item) return;
  item.overridden = true;
  item.overrideKind = info.kind;
  item.overrideRuleId = info.ruleId;
  if (info.status != null) item.status = info.status;
  // Keep the real server body as a separate field for diff'ing later
  if (info.originalBody !== undefined) item.serverBody = info.originalBody;
  else if (item.resBody && item.resBody !== '[binary]') item.serverBody = item.resBody;
  item.resBody = info.body;
}

function continueThrough(source, requestId, isResponseStage, responseHeaders) {
  if (isResponseStage) {
    return chrome.debugger.sendCommand(source, 'Fetch.continueResponse', { requestId });
  }
  return chrome.debugger.sendCommand(source, 'Fetch.continueRequest', { requestId });
}

function bumpHit(rule) {
  rule.hits = (rule.hits || 0) + 1;
  if (rule.times > 0 && rule.hits >= rule.times) rule.enabled = false;
  // persist hit counts lazily
  persistRules().catch(() => {});
}

// ------------------------------------------------------------
// Network domain → request log (for tail_requests)
// ------------------------------------------------------------
function onNetworkRequestWillBeSent(source, p) {
  const { requestId, request, timestamp, type } = p;
  pushRecent({
    id: requestId,
    tabId: source.tabId,
    url: request.url,
    method: request.method,
    type,
    reqHeaders: request.headers || {},
    reqBody: request.postData || null,
    status: null,
    statusText: null,
    resHeaders: null,
    resBody: null,
    ts: Date.now()
  });
}

function onNetworkResponseReceived(source, p) {
  const { requestId, response } = p;
  const item = state.recent.find(r => r.id === requestId);
  if (item) {
    item.status = response.status;
    item.statusText = response.statusText;
    item.resHeaders = response.headers;
    item.mimeType = response.mimeType;
  }
}

async function onNetworkLoadingFinished(source, p) {
  const { requestId } = p;
  const item = state.recent.find(r => r.id === requestId);
  if (!item || item.resBody !== null) return;
  // Best-effort body capture; will fail for some types/Fetch-fulfilled requests.
  try {
    const r = await chrome.debugger.sendCommand({ tabId: source.tabId }, 'Network.getResponseBody', { requestId });
    item.resBody = r.base64Encoded ? '[binary]' : r.body;
  } catch {
    // ignore
  }
}

function pushRecent(item) {
  state.recent.push(item);
  if (state.recent.length > MAX_RECENT) state.recent.splice(0, state.recent.length - MAX_RECENT);
}

function tailRequests(n, filter) {
  let arr = state.recent.slice();
  if (filter?.tabId != null) arr = arr.filter(r => r.tabId === filter.tabId);
  if (filter?.url) arr = arr.filter(r => globMatch(r.url, filter.url));
  if (filter?.method) arr = arr.filter(r => r.method.toUpperCase() === filter.method.toUpperCase());
  if (filter?.status) {
    const want = String(filter.status);
    arr = arr.filter(r => r.status != null && String(r.status).startsWith(want));
  }
  if (filter?.type) arr = arr.filter(r => matchType(r.type, filter.type));
  arr = arr.slice(-n);
  // Don't ship full bodies in tail by default — let user request them
  return arr.map(r => ({
    id: r.id, tabId: r.tabId, url: r.url, method: r.method,
    status: r.status, statusText: r.statusText, type: r.type,
    mimeType: r.mimeType, ts: r.ts,
    bodyAvailable: r.resBody != null && r.resBody !== '[binary]',
    bodyPreview: previewBody(r.resBody),
    overridden: !!r.overridden,
    overrideKind: r.overrideKind || null,
    overrideRuleId: r.overrideRuleId || null
  }));
}

function previewBody(body) {
  if (!body || body === '[binary]') return null;
  return body.length > 200 ? body.slice(0, 200) + '…' : body;
}

function getRequest(reqId) {
  const r = state.recent.find(x => x.id === reqId);
  if (!r) throw new Error(`request not found: ${reqId}`);
  return r;
}

// Convenience: build a fulfill rule from a captured request, optionally
// applying a deep-merge patch to the original JSON body.
async function mockFromRequest(reqId, patch) {
  const r = getRequest(reqId);
  if (!r.resBody) throw new Error('no captured response body for that request');
  let body = r.resBody;
  let isJson = false;
  try {
    const j = JSON.parse(body);
    isJson = true;
    const patched = patch && Object.keys(patch).length ? deepMerge(j, patch) : j;
    body = JSON.stringify(patched);
  } catch { /* keep as text */ }

  const rule = {
    note: `mock_from_request ${r.method} ${r.url}`,
    match: { url: r.url, method: r.method },
    action: {
      type: 'fulfill',
      status: r.status || 200,
      headers: { 'content-type': isJson ? 'application/json' : (r.mimeType || 'text/plain') },
      body
    }
  };
  return addRule(rule);
}

// ------------------------------------------------------------
// Rule matching
// ------------------------------------------------------------
function findMatchingRule(request, isResponseStage) {
  for (const r of state.rules) {
    if (!r.enabled) continue;
    if (r.match.method !== '*' && r.match.method !== request.method.toUpperCase()) continue;
    if (!globMatch(request.url, r.match.url)) continue;
    // Response-stage actions only fire after the network response arrives;
    // every other action (fulfill / block / redirect) runs at request stage.
    const t = r.action?.type;
    const isResponseStageType = (t === 'passthrough_patch' || t === 'passthrough_text_patch');
    if (isResponseStage !== isResponseStageType) continue;
    return r;
  }
  return null;
}

// glob support: '*' matches any chars, '?' matches single. Also accepts /regex/.
function globMatch(s, pattern) {
  if (!pattern || pattern === '*') return true;
  if (pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 1) {
    return new RegExp(pattern.slice(1, -1)).test(s);
  }
  const re = new RegExp('^' + pattern.split('').map(c => {
    if (c === '*') return '.*';
    if (c === '?') return '.';
    return c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }).join('') + '$');
  return re.test(s);
}

// ------------------------------------------------------------
// Utilities
// ------------------------------------------------------------
function toHeaderArray(obj) {
  return Object.entries(obj).map(([name, value]) => ({ name, value: String(value) }));
}

// When fulfilling a cross-origin request, the browser will block our mocked
// response unless it carries the right CORS headers. Add them automatically
// based on the request's Origin header, unless the rule already set them.
function addAutoCorsHeaders(headers, request) {
  const reqHeaders = request?.headers || {};
  // Headers come as a plain object on Fetch.requestPaused.request.
  const origin = pickHeader(reqHeaders, 'origin');
  if (!origin) return;
  const hasName = (n) => headers.some(h => h.name.toLowerCase() === n);
  if (!hasName('access-control-allow-origin')) {
    headers.push({ name: 'access-control-allow-origin', value: origin });
  }
  // Browsers reject `*` origin when credentials (cookies) are involved, so we
  // echo the Origin back and explicitly allow credentials. This is the safe
  // default for "make the page see my mock as if it came from the real server".
  if (!hasName('access-control-allow-credentials')) {
    headers.push({ name: 'access-control-allow-credentials', value: 'true' });
  }
  // If the original request came with an Access-Control-Request-Headers header
  // (it's a preflight), echo those back as allowed.
  const acrh = pickHeader(reqHeaders, 'access-control-request-headers');
  if (acrh && !hasName('access-control-allow-headers')) {
    headers.push({ name: 'access-control-allow-headers', value: acrh });
  }
  const acrm = pickHeader(reqHeaders, 'access-control-request-method');
  if (acrm && !hasName('access-control-allow-methods')) {
    headers.push({ name: 'access-control-allow-methods', value: acrm });
  }
}

function pickHeader(obj, name) {
  if (!obj) return null;
  const lower = name.toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === lower) return obj[k];
  }
  return null;
}

function encodeBodyBase64(s) {
  // utf-8 → base64
  const bytes = new TextEncoder().encode(String(s));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function safeAtob(b64) {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch { return ''; }
}

function guessContentType(body) {
  const s = String(body).trim();
  if (s.startsWith('{') || s.startsWith('[')) return 'application/json; charset=utf-8';
  if (s.startsWith('<')) return 'text/html; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

function deepMerge(target, source) {
  if (Array.isArray(source)) return source;            // arrays replace
  if (typeof source !== 'object' || source === null) return source;
  if (typeof target !== 'object' || target === null) target = {};
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const k of Object.keys(source)) {
    out[k] = deepMerge(target[k], source[k]);
  }
  return out;
}

// Minimal RFC 6902 JSON Patch (add/remove/replace/copy/move/test)
function applyJsonPatch(doc, ops) {
  for (const op of ops) {
    const path = parsePointer(op.path);
    if (op.op === 'add' || op.op === 'replace') setAt(doc, path, op.value);
    else if (op.op === 'remove') removeAt(doc, path);
    else if (op.op === 'copy') setAt(doc, path, getAt(doc, parsePointer(op.from)));
    else if (op.op === 'move') {
      const from = parsePointer(op.from);
      const v = getAt(doc, from);
      removeAt(doc, from);
      setAt(doc, path, v);
    } else if (op.op === 'test') {
      if (JSON.stringify(getAt(doc, path)) !== JSON.stringify(op.value)) {
        throw new Error(`json-patch test failed at ${op.path}`);
      }
    }
  }
  return doc;
}

function parsePointer(p) {
  if (!p || p === '/') return [];
  return p.split('/').slice(1).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}
function getAt(o, path) { return path.reduce((acc, k) => acc?.[k], o); }
function setAt(o, path, v) {
  if (!path.length) throw new Error('cannot set root');
  let cur = o;
  for (let i = 0; i < path.length - 1; i++) {
    if (cur[path[i]] === undefined) cur[path[i]] = {};
    cur = cur[path[i]];
  }
  cur[path[path.length - 1]] = v;
}
function removeAt(o, path) {
  if (!path.length) return;
  let cur = o;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]];
  if (Array.isArray(cur)) cur.splice(Number(path[path.length - 1]), 1);
  else delete cur[path[path.length - 1]];
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function log(...args) { console.log('[api-override]', ...args); }
