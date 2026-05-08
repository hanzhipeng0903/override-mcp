// Popup talks to the background service worker via chrome.runtime.sendMessage.
// All state changes round-trip through the SW so the popup stays simple.

function callBg(method, params) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ __popup: true, method, params }, resolve);
  });
}

// Detect full-page mode (opened as a tab via the ↗ button)
const params = new URLSearchParams(location.search);
const isFullpage = params.has('fullpage');
const initialDetailId = params.get('detail');
let pendingDetailOpen = !!initialDetailId;

if (isFullpage) {
  document.body.classList.add('fullpage');
  document.title = 'API Override — 控制台';
  // In fullpage mode, "最近请求" doesn't make sense — the active tab is THIS
  // page itself, which has no traffic. Hide it and default to the rules tab.
  document.querySelector('nav button[data-tab="recent"]').style.display = 'none';
  document.getElementById('tab-recent').style.display = 'none';
  // Activate the rules tab as default
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  const rulesNav = document.querySelector('nav button[data-tab="rules"]');
  rulesNav.classList.add('active');
  document.getElementById('tab-rules').style.display = 'block';
}

const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const truncate = (s, n) => s == null ? '' : (s.length > n ? s.slice(0, n - 1) + '…' : s);
const shortUrl = (u) => {
  try {
    const url = new URL(u);
    const limit = isFullpage ? 200 : 30;  // give more room in fullpage view
    return url.pathname + (url.search.length > limit ? url.search.slice(0, limit) + '…' : url.search);
  } catch { return u; }
};

let state = { activeTab: null, recent: [], rules: [], autoAttach: { enabled: true, hosts: [] }, bridge: null };
let typeFilter = 'api'; // 'api' | 'all' | 'XHR' | 'Document' | 'Script' | etc.
let recentSearch = '';
let rulesSearch = '';

function wireSearchInput(inputId, clearId, getter, setter) {
  const inp = $(inputId), clear = $(clearId);
  const wrap = inp.closest('.search-box');
  inp.addEventListener('input', () => {
    setter(inp.value);
    wrap.classList.toggle('has-value', !!inp.value);
    refresh();
  });
  clear.addEventListener('click', () => {
    inp.value = '';
    setter('');
    wrap.classList.remove('has-value');
    inp.focus();
    refresh();
  });
  // Initial sync
  inp.value = getter();
  wrap.classList.toggle('has-value', !!getter());
}

wireSearchInput('recent-search', 'recent-search-clear',
  () => recentSearch, (v) => recentSearch = v);
wireSearchInput('rules-search', 'rules-search-clear',
  () => rulesSearch, (v) => rulesSearch = v);

// Restore saved filter on load
chrome.storage.local.get(['popupTypeFilter']).then(d => {
  if (d.popupTypeFilter) typeFilter = d.popupTypeFilter;
  updateChips();
  refresh();
});

function updateChips() {
  document.querySelectorAll('#type-filter .chip').forEach(c => {
    c.classList.toggle('active', c.dataset.type === typeFilter);
  });
}

document.querySelectorAll('#type-filter .chip').forEach(btn => {
  btn.addEventListener('click', async () => {
    typeFilter = btn.dataset.type;
    await chrome.storage.local.set({ popupTypeFilter: typeFilter });
    updateChips();
    refresh();
  });
});

// ---- tab switching ----
document.querySelectorAll('nav button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('section').forEach(s => s.style.display = 'none');
    $('tab-' + btn.dataset.tab).style.display = 'block';
  });
});

// ---- header ----
$('toggle').addEventListener('click', async () => {
  const s = await callBg('status');
  await callBg(s?.enabled ? 'disable' : 'enable');
  refresh();
});

$('open-tab').addEventListener('click', async () => {
  const url = chrome.runtime.getURL('popup.html?fullpage=1');
  // If we already have a tab open with the full-page view, focus it instead.
  const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('popup.html?*') });
  if (tabs.length) {
    chrome.tabs.update(tabs[0].id, { active: true });
    chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    chrome.tabs.create({ url });
  }
  window.close();
});

$('attach-btn').addEventListener('click', async () => {
  const r = await callBg('attach_active');
  if (r?.error) alert(r.error);
  refresh();
});

$('detach-btn').addEventListener('click', async () => {
  if (!state.activeTab) return;
  await callBg('detach', { tabId: state.activeTab.id });
  refresh();
});

// ---- rules ----
$('clear-rules-btn').addEventListener('click', async () => {
  if (state.rules.length === 0) return;
  if (!confirm(`确认清空 ${state.rules.length} 条规则？`)) return;
  await callBg('clear_rules');
  refresh();
});

// ---- settings ----
$('auto-enabled').addEventListener('change', async (e) => {
  await callBg('set_auto_attach_enabled', { enabled: e.target.checked });
  refresh();
});

$('add-host').addEventListener('click', async () => {
  const v = $('new-host').value.trim();
  if (!v) return;
  await callBg('add_auto_host', { pattern: v });
  $('new-host').value = '';
  refresh();
});

$('new-host').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('add-host').click();
});

$('bridge-save').addEventListener('click', async () => {
  const host = $('bridge-host').value.trim() || 'localhost';
  const port = Number($('bridge-port').value) || 9876;
  const r = await callBg('set_bridge_address', { host, port });
  if (r?.error) { alert('保存失败：' + r.error); return; }
  refresh();
});

$('bridge-port').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('bridge-save').click();
});
$('bridge-host').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('bridge-save').click();
});

// ---- editor modal ----
// editorContext fields:
//   url, method, mimeType         — common
//   editingRuleId (optional)      — set when editing an existing rule
let editorContext = null;

function openEditor(req, originalBody) {
  editorContext = { url: req.url, method: req.method, mimeType: req.mimeType };
  $('editor-target').textContent = `${req.method} ${req.url}`;
  let body = originalBody || '';
  if ($('editor-pretty').checked) {
    try { body = JSON.stringify(JSON.parse(body), null, 2); } catch {}
  }
  $('editor-body').value = body;
  $('editor-status').value = req.status || 200;
  $('editor').classList.add('open');
  setTimeout(() => $('editor-body').focus(), 50);
}

function openEditorForRule(rule) {
  if (!rule || rule.action.type !== 'fulfill') return;
  const ct = rule.action.headers
    ? (rule.action.headers['content-type'] || rule.action.headers['Content-Type'] || 'application/json')
    : 'application/json';
  editorContext = {
    url: rule.match.url,
    method: rule.match.method,
    mimeType: ct,
    editingRuleId: rule.id
  };
  $('editor-target').textContent = `编辑规则：${rule.match.method} ${rule.match.url}`;
  let body = rule.action.body || '';
  if ($('editor-pretty').checked) {
    try { body = JSON.stringify(JSON.parse(body), null, 2); } catch {}
  }
  $('editor-body').value = body;
  $('editor-status').value = rule.action.status || 200;
  $('editor').classList.add('open');
  setTimeout(() => $('editor-body').focus(), 50);
}

function closeEditor() {
  $('editor').classList.remove('open');
  editorContext = null;
}

$('editor-cancel').addEventListener('click', closeEditor);
$('editor').addEventListener('click', (e) => { if (e.target === $('editor')) closeEditor(); });

// Click a rule. In the small popup we open the full-page console with this rule
// pre-selected so the detail modal renders with proper space. In full-page mode
// we just show the modal in place.
async function handleRuleClick(rule) {
  if (isFullpage) return openDetail(rule);
  const url = chrome.runtime.getURL(`popup.html?fullpage=1&detail=${encodeURIComponent(rule.id)}`);
  // Reuse the existing console tab if it's already open
  try {
    const existing = await chrome.tabs.query({ url: chrome.runtime.getURL('popup.html') + '*' });
    if (existing.length) {
      await chrome.tabs.update(existing[0].id, { active: true, url });
      await chrome.windows.update(existing[0].windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url });
    }
  } catch {
    chrome.tabs.create({ url });
  }
  window.close();
}

// ---- rule detail modal ----
let detailContext = null; // current rule shown in detail

function openDetail(rule) {
  detailContext = rule;
  $('detail-body').innerHTML = renderRuleDetail(rule);
  $('detail-edit').style.display = rule.action?.type === 'fulfill' ? '' : 'none';
  $('detail').classList.add('open');
}
function closeDetail() {
  $('detail').classList.remove('open');
  detailContext = null;
}
$('detail-close').addEventListener('click', closeDetail);
$('detail').addEventListener('click', (e) => { if (e.target === $('detail')) closeDetail(); });
$('detail-edit').addEventListener('click', () => {
  if (!detailContext) return;
  const r = detailContext;
  closeDetail();
  openEditorForRule(r);
});
$('detail-delete').addEventListener('click', async () => {
  if (!detailContext) return;
  if (!confirm('删除这条规则？')) return;
  await callBg('remove_rule', { id: detailContext.id });
  closeDetail();
  refresh();
});

function prettyJson(s) {
  if (s == null) return '';
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return String(s); }
}

function renderRuleDetail(r) {
  const a = r.action || {};
  const rows = [];
  const row = (k, vHtml) => rows.push(`<div class="kv"><span class="k">${k}</span><span class="v">${vHtml}</span></div>`);

  row('动作', `<span class="badge-action ${escapeHtml(a.type || '')}">${escapeHtml(a.type || '')}</span>${r.enabled === false ? ' <span style="font-size:10px;color:var(--muted);margin-left:6px">（已禁用）</span>' : ''}`);
  row('URL 模式', `<code>${escapeHtml(r.match?.url || '*')}</code>`);
  row('方法', `<code>${escapeHtml(r.match?.method || '*')}</code>`);

  if (a.type === 'fulfill') {
    row('状态码', `<code>${a.status ?? 200}</code>`);
    if (a.headers && Object.keys(a.headers).length) {
      const hdrs = Object.entries(a.headers).map(([k, v]) => `${k}: ${v}`).join('\n');
      row('响应头', `<pre>${escapeHtml(hdrs)}</pre>`);
    }
    row('响应 body', `<pre>${escapeHtml(prettyJson(a.body))}</pre>`);
  } else if (a.type === 'passthrough_patch') {
    if (a.status != null) row('改写状态码', `<code>${a.status}</code>`);
    if (a.merge && Object.keys(a.merge).length) {
      row('deep-merge', `<pre>${escapeHtml(JSON.stringify(a.merge, null, 2))}</pre>`);
    }
    if (Array.isArray(a.jsonPatch) && a.jsonPatch.length) {
      row('JSON Patch', `<pre>${escapeHtml(JSON.stringify(a.jsonPatch, null, 2))}</pre>`);
    }
    if (!a.merge && !a.jsonPatch?.length) {
      row('改写内容', '<span style="color:var(--muted)">未配置 patch（实际不改）</span>');
    }
  } else if (a.type === 'block') {
    row('错误原因', `<code>${escapeHtml(a.reason || 'Failed')}</code>`);
  }

  row('命中次数', `<b>${r.hits || 0}</b>`);
  if (r.delay > 0) row('人为延时', `<code>${r.delay} ms</code>`);
  if (r.times > 0) row('命中上限', `<code>${r.times}</code>（达到后自动禁用）`);
  if (r.note) row('备注', `<span class="muted-tiny">${escapeHtml(r.note)}</span>`);
  if (r.createdAt) row('创建时间', `<span class="muted-tiny">${new Date(r.createdAt).toLocaleString()}</span>`);
  if (r.id) row('ID', `<span class="muted-tiny">${escapeHtml(r.id)}</span>`);

  return rows.join('');
}

$('editor-pretty').addEventListener('change', () => {
  const ta = $('editor-body');
  if ($('editor-pretty').checked) {
    try { ta.value = JSON.stringify(JSON.parse(ta.value), null, 2); } catch {}
  } else {
    try { ta.value = JSON.stringify(JSON.parse(ta.value)); } catch {}
  }
});

$('editor-save').addEventListener('click', async () => {
  if (!editorContext) return;
  const body = $('editor-body').value;
  const status = Number($('editor-status').value) || 200;
  // Compress JSON before saving (storage is small) but accept user's formatted text too
  let storedBody = body;
  try { storedBody = JSON.stringify(JSON.parse(body)); } catch {}
  const isJson = (() => { try { JSON.parse(body); return true; } catch { return false; } })();
  const action = {
    type: 'fulfill',
    status,
    headers: { 'content-type': isJson ? 'application/json' : (editorContext.mimeType || 'text/plain') },
    body: storedBody
  };

  let r;
  if (editorContext.editingRuleId) {
    // Update existing rule (only the action; preserve match / note / etc.)
    r = await callBg('update_rule', { id: editorContext.editingRuleId, patch: { action } });
  } else {
    // Create new rule from a recent request
    let pattern;
    try {
      const u = new URL(editorContext.url);
      pattern = u.origin + u.pathname + (u.search ? '*' : '');
    } catch { pattern = editorContext.url; }
    r = await callBg('add_rule', {
      rule: {
        note: `Popup mock: ${editorContext.method} ${shortUrl(editorContext.url)}`,
        match: { url: pattern, method: editorContext.method },
        action
      }
    });
  }
  if (r?.error) { alert('保存失败：' + r.error); return; }
  closeEditor();
  document.querySelector('nav button[data-tab="rules"]').click();
  refresh();
});

// ---- list rendering ----

function renderRecent() {
  const container = $('recent-list');
  if (!state.activeTab) {
    container.innerHTML = '<div class="empty">没有活动 tab</div>';
    return;
  }
  if (!state.activeTab.attached) {
    container.innerHTML = '<div class="empty">这个 tab 还没 attach。点右上"Attach"开始抓包</div>';
    return;
  }
  // Apply text filter on top of the type-filtered list from active_context
  let items = state.recent;
  if (recentSearch) {
    const q = recentSearch.toLowerCase();
    items = items.filter(r =>
      (r.url || '').toLowerCase().includes(q) ||
      (r.method || '').toLowerCase().includes(q)
    );
  }
  if (!items.length) {
    let hint;
    if (recentSearch) {
      hint = `没有匹配 <b>"${escapeHtml(recentSearch)}"</b> 的请求`;
    } else if (typeFilter && typeFilter !== 'all') {
      hint = `没有匹配 <b>${escapeHtml(typeFilter === 'api' ? 'XHR+Fetch' : typeFilter)}</b> 的请求。换"全部"看看，或者操作一下页面触发请求`;
    } else {
      hint = '已 attach。刷新页面或操作页面后会出现请求';
    }
    container.innerHTML = `<div class="empty">${hint}</div>`;
    return;
  }
  container.innerHTML = '';
  // Show newest first
  for (const r of [...items].reverse()) {
    const div = document.createElement('div');
    div.className = 'req';
    const sclass = r.status ? 's' + String(r.status)[0] : '';
    const typeTag = r.type ? `<span title="${escapeHtml(r.type)}" style="font-size:9px;color:var(--muted);padding:1px 4px;background:var(--tag-bg);border-radius:3px;margin-right:4px">${escapeHtml(r.type.slice(0,4))}</span>` : '';
    div.innerHTML = `
      <span class="method">${escapeHtml(r.method)}</span>
      <span class="status ${sclass}">${r.status ?? '—'}</span>
      <span class="url" title="${escapeHtml(r.url)}">${typeTag}${escapeHtml(shortUrl(r.url))}</span>
      <span>${r.overridden ? '<span class="ovr">MOCK</span>' : ''}</span>
      <button class="btn" data-id="${escapeHtml(r.id)}">Mock</button>
    `;
    div.querySelector('button').addEventListener('click', async () => {
      const detail = await callBg('get_request', { reqId: r.id });
      if (detail?.error) { alert(detail.error); return; }
      openEditor(r, detail?.resBody || '');
    });
    container.appendChild(div);
  }
}

function actionSummary(action) {
  if (!action) return '';
  if (action.type === 'fulfill') return `→ ${action.status || 200} ${truncate(action.body || '', 40)}`;
  if (action.type === 'passthrough_patch') {
    const m = action.merge ? Object.keys(action.merge).join(',') : '';
    const p = action.jsonPatch?.length ? `+${action.jsonPatch.length} patch` : '';
    return `patch: ${m}${m && p ? ' ' : ''}${p}`;
  }
  if (action.type === 'block') return `× block (${action.reason || 'Failed'})`;
  return action.type;
}

function renderRules() {
  const container = $('rules-list');
  if (!state.rules.length) {
    container.innerHTML = '<div class="empty">还没有规则。在"最近请求"里点 Mock 创建</div>';
    return;
  }
  let rules = state.rules;
  if (rulesSearch) {
    const q = rulesSearch.toLowerCase();
    rules = rules.filter(r =>
      (r.match?.url || '').toLowerCase().includes(q) ||
      (r.match?.method || '').toLowerCase().includes(q) ||
      (r.note || '').toLowerCase().includes(q)
    );
  }
  if (!rules.length) {
    container.innerHTML = `<div class="empty">没有匹配 <b>"${escapeHtml(rulesSearch)}"</b> 的规则</div>`;
    return;
  }
  container.innerHTML = '';
  for (const r of rules) {
    const div = document.createElement('div');
    div.className = 'rule' + (r.enabled === false ? ' disabled' : '');
    div.style.cursor = 'pointer';
    div.title = '点击查看详情';
    div.innerHTML = `
      <div class="head">
        <input type="checkbox" class="switch" ${r.enabled === false ? '' : 'checked'} />
        <span class="method-tag">${escapeHtml(r.match.method || '*')}</span>
        <span class="pat">${escapeHtml(r.match.url || '*')}</span>
        <button class="btn danger" data-act="del" style="padding:2px 7px;font-size:12px;line-height:1">×</button>
      </div>
      <div class="meta">
        <span>${escapeHtml(actionSummary(r.action))}</span>
        <span>命中 <b>${r.hits || 0}</b> 次</span>
        ${r.note ? `<span class="note">${escapeHtml(r.note)}</span>` : ''}
      </div>
    `;
    const toggle = div.querySelector('input[type="checkbox"]');
    const del = div.querySelector('button[data-act="del"]');
    toggle.addEventListener('change', async (ev) => {
      ev.stopPropagation();
      await callBg('update_rule', { id: r.id, patch: { enabled: toggle.checked } });
      refresh();
    });
    toggle.addEventListener('click', (ev) => ev.stopPropagation());
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm('删除这条规则？')) return;
      await callBg('remove_rule', { id: r.id });
      refresh();
    });
    div.addEventListener('click', () => handleRuleClick(r));
    container.appendChild(div);
  }
}

function renderSettings() {
  $('auto-enabled').checked = state.autoAttach.enabled;
  // Bridge inputs — only update when not currently focused, so we don't stomp
  // the user's typing on the 1.5s refresh tick.
  if (state.bridge) {
    if (document.activeElement !== $('bridge-host')) {
      $('bridge-host').value = state.bridge.host || 'localhost';
    }
    if (document.activeElement !== $('bridge-port')) {
      $('bridge-port').value = state.bridge.port || 9876;
    }
  }
  const container = $('hosts-list');
  if (!state.autoAttach.hosts.length) {
    container.innerHTML = '<div class="empty">未添加任何 host。匹配的 tab 打开时会自动 attach</div>';
    return;
  }
  container.innerHTML = '';
  for (const h of state.autoAttach.hosts) {
    const div = document.createElement('div');
    div.className = 'host-item';
    div.innerHTML = `<span class="glyph">●</span><span style="flex:1">${escapeHtml(h)}</span><button class="btn danger" style="padding:2px 7px;font-size:12px;line-height:1">×</button>`;
    div.querySelector('button').addEventListener('click', async () => {
      await callBg('remove_auto_host', { pattern: h });
      refresh();
    });
    container.appendChild(div);
  }
}

// ---- main refresh loop ----

async function refresh() {
  const [s, ctx, rules, autoAttach, bridge] = await Promise.all([
    callBg('status'),
    callBg('active_context', { n: 30, type: typeFilter }),
    callBg('list_rules'),
    callBg('get_auto_attach'),
    callBg('get_bridge_address')
  ]);
  state.bridge = bridge;

  // Header
  const wsConnected = s?.wsConnected;
  $('bridge').className = 'pill ' + (wsConnected ? 'ok' : 'bad');
  $('bridge').textContent = wsConnected ? 'connected' : 'disconnected';
  $('bridge').title = bridge?.url ? (wsConnected ? `已连接 ${bridge.url}` : `尝试连接 ${bridge.url}`) : '';

  $('toggle').textContent = s?.enabled ? 'on' : 'off';
  $('toggle').className = 'btn ' + (s?.enabled ? 'primary' : '');

  $('stats').textContent = [
    `attached: ${s?.attachedTabs?.length || 0}`,
    `规则: ${rules?.length || 0}`,
    `捕获: ${s?.recentCount || 0}`
  ].join(' · ');

  $('badge-recent').textContent = ctx?.recent?.length || 0;
  $('badge-rules').textContent = rules?.length || 0;

  // Active tab info
  state.activeTab = ctx?.active;
  state.recent = ctx?.recent || [];
  state.rules = Array.isArray(rules) ? rules : [];
  state.autoAttach = autoAttach || { enabled: true, hosts: [] };

  if (state.activeTab) {
    $('active-info').textContent = `#${state.activeTab.id} ${truncate(state.activeTab.title || state.activeTab.url || '', 50)}`;
    $('attach-btn').disabled = state.activeTab.attached;
    $('detach-btn').disabled = !state.activeTab.attached;
    $('attach-btn').textContent = state.activeTab.attached ? 'Attached ✓' : 'Attach';
  } else {
    $('active-info').textContent = '没有活动 tab';
    $('attach-btn').disabled = true;
    $('detach-btn').disabled = true;
  }

  renderRecent();
  renderRules();
  renderSettings();

  // If launched with ?detail=<ruleId>, auto-open the detail modal once.
  if (pendingDetailOpen) {
    const r = state.rules.find(x => x.id === initialDetailId);
    if (r) {
      openDetail(r);
      pendingDetailOpen = false;
    } else if (state.rules.length) {
      // Rules loaded but the requested rule isn't there (deleted) — give up
      pendingDetailOpen = false;
    }
  }
}

refresh();
setInterval(refresh, 1500);
