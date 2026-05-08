// MCP tool definitions. Each tool forwards to the extension via the bridge.

import { z } from 'zod';

// Reusable schemas
const RuleMatch = z.object({
  url: z.string().describe('URL pattern. Glob (`*`/`?`) or `/regex/`. Examples: `*api/users*`, `/^https:\\/\\/x\\.com\\/api\\/.+/`'),
  method: z.string().default('*').describe('HTTP method, or `*` for any')
});

const FulfillAction = z.object({
  type: z.literal('fulfill'),
  status: z.number().int().default(200),
  headers: z.record(z.string()).default({}),
  body: z.string().describe('Response body as string. JSON should be a JSON-encoded string.')
});

const PassthroughPatchAction = z.object({
  type: z.literal('passthrough_patch'),
  status: z.number().int().nullable().optional().describe('Override status code. Null = keep original.'),
  merge: z.record(z.any()).optional().describe('Object that will be deep-merged into the original JSON response.'),
  jsonPatch: z.array(z.object({
    op: z.enum(['add', 'remove', 'replace', 'copy', 'move', 'test']),
    path: z.string(),
    from: z.string().optional(),
    value: z.any().optional()
  })).optional().describe('RFC 6902 JSON Patch ops applied after `merge`.')
});

const BlockAction = z.object({
  type: z.literal('block'),
  reason: z.string().default('Failed').describe('CDP error reason, e.g. Failed, Aborted, TimedOut, ConnectionRefused')
});

const RuleAction = z.union([FulfillAction, PassthroughPatchAction, BlockAction]);

const RuleInput = z.object({
  id: z.string().optional(),
  enabled: z.boolean().optional().default(true),
  note: z.string().optional(),
  match: RuleMatch,
  action: RuleAction,
  delay: z.number().int().min(0).default(0).describe('Artificial delay in ms before responding'),
  times: z.number().int().default(-1).describe('Auto-disable after N matches. -1 = unlimited.')
});

export function buildTools(bridge) {
  return [
    {
      name: 'status',
      description: 'Show extension connection state, override toggle, attached tabs, rule and request counts.',
      inputSchema: z.object({}),
      handler: async () => {
        const s = await bridge.call('status');
        return { ...s, bridgeConnected: bridge.isConnected() };
      }
    },

    {
      name: 'active_context',
      description: [
        '⭐ START HERE when the user mentions "this page", "the current tab", "the page I\'m on", or doesn\'t specify a tab.',
        'Returns: the active tab (id, url, title, attached state), global enabled flag, rule count, and the most recent N requests SCOPED TO that tab.',
        'By default returns only API calls (XHR + Fetch) — the requests users almost always want to mock. Pass type:"all" or specific CDP types to broaden.',
        'After calling this you usually have everything needed to: pick a request to mock, decide if you need to attach first, identify the right URL pattern.'
      ].join(' '),
      inputSchema: z.object({
        n: z.number().int().min(1).max(50).default(10).describe('How many recent requests to include'),
        type: z.union([
          z.literal('all'),
          z.literal('api'),
          z.string(),
          z.array(z.string())
        ]).optional().default('api').describe('Resource type filter. Defaults to "api" (XHR+Fetch). Use "all" to disable filtering, or pass a CDP type name like "Document"/"Script"/"Stylesheet"/"Image"/"Font"/"Media"/"WebSocket", or an array.')
      }),
      handler: async (args) => bridge.call('active_context', args)
    },

    {
      name: 'list_tabs',
      description: 'List ALL browser tabs (across windows). Use this only when the user references a tab that is NOT the active one. For "this page" / current tab, prefer `active_context`.',
      inputSchema: z.object({}),
      handler: async () => bridge.call('list_tabs')
    },

    {
      name: 'attach',
      description: 'Start intercepting requests on a tab (triggers yellow "debugging" banner). If `tabId` is omitted, attaches to the active tab. Required before any `fulfill` / `passthrough_patch` / `block` rule can fire on that tab.',
      inputSchema: z.object({
        tabId: z.number().int().optional().describe('Omit to use the active tab')
      }),
      handler: async (args) => bridge.call('attach', args)
    },

    {
      name: 'attach_active',
      description: 'Same as `attach` with no tabId — kept for backward compat. Prefer `attach` (tabId optional).',
      inputSchema: z.object({}),
      handler: async () => bridge.call('attach_active')
    },

    {
      name: 'detach',
      description: 'Stop intercepting on a tab and remove the yellow banner. Omit `tabId` to use the active tab.',
      inputSchema: z.object({
        tabId: z.number().int().optional().describe('Omit to use the active tab')
      }),
      handler: async (args) => bridge.call('detach', args)
    },

    {
      name: 'enable',
      description: 'Globally enable rule matching. Rules are still stored when disabled.',
      inputSchema: z.object({}),
      handler: async () => bridge.call('enable')
    },

    {
      name: 'disable',
      description: 'Globally disable rule matching without deleting rules.',
      inputSchema: z.object({}),
      handler: async () => bridge.call('disable')
    },

    {
      name: 'list_rules',
      description: 'List all override rules.',
      inputSchema: z.object({}),
      handler: async () => bridge.call('list_rules')
    },

    {
      name: 'add_rule',
      description: [
        'Add an override rule.',
        '',
        'Action types:',
        '  * `fulfill`        — return mock without hitting network (works even if real endpoint 404s or DNS fails)',
        '  * `passthrough_patch` — let request through, then patch the JSON response (`merge` and/or `jsonPatch`)',
        '  * `block`          — simulate a network error (failure reason is configurable)',
        '',
        'Examples:',
        '  Mock a 404 endpoint as 200 JSON:',
        '    { match: { url: "*api/v2/preferences*" }, action: { type: "fulfill", status: 200, body: "{\\"theme\\":\\"dark\\"}" } }',
        '  Force vip=true in user profile response:',
        '    { match: { url: "*api/me" }, action: { type: "passthrough_patch", merge: { vip: true } } }',
        '  Simulate connection refused:',
        '    { match: { url: "*ads*" }, action: { type: "block", reason: "ConnectionRefused" } }'
      ].join('\n'),
      inputSchema: z.object({ rule: RuleInput }),
      handler: async (args) => bridge.call('add_rule', { rule: args.rule })
    },

    {
      name: 'update_rule',
      description: 'Update fields on an existing rule by id.',
      inputSchema: z.object({
        id: z.string(),
        patch: z.object({}).passthrough()
      }),
      handler: async (args) => bridge.call('update_rule', args)
    },

    {
      name: 'remove_rule',
      description: 'Delete a rule by id.',
      inputSchema: z.object({ id: z.string() }),
      handler: async (args) => bridge.call('remove_rule', args)
    },

    {
      name: 'clear_rules',
      description: 'Delete all override rules.',
      inputSchema: z.object({}),
      handler: async () => bridge.call('clear_rules')
    },

    {
      name: 'tail_requests',
      description: [
        'Show the most recent N captured requests across all attached tabs. Each entry includes status, URL, mime, body preview (200 chars), and an `overridden` flag indicating the request had its response body mutated by a rule.',
        'For the user\'s CURRENT tab, prefer `active_context` (it scopes results automatically). Use this tool when you need to look across multiple tabs or apply a `filter`.',
        'Call `get_request` with `reqId` to fetch the full body.'
      ].join(' '),
      inputSchema: z.object({
        n: z.number().int().min(1).max(200).default(20),
        filter: z.object({
          tabId: z.union([z.number().int(), z.literal('active')]).optional().describe('Number = specific tab, "active" = active tab, omit = all attached tabs'),
          url: z.string().optional(),
          method: z.string().optional(),
          type: z.union([
            z.literal('all'),
            z.literal('api'),
            z.string(),
            z.array(z.string())
          ]).optional().describe('Resource type. "api" = XHR+Fetch, "all" = no filter, or specific CDP types: XHR, Fetch, Document, Stylesheet, Script, Image, Font, Media, WebSocket, Other. Omit for no filter.'),
          status: z.union([z.number(), z.string()]).optional().describe('Exact status or prefix, e.g. 4 matches all 4xx')
        }).optional()
      }),
      handler: async (args) => bridge.call('tail_requests', args)
    },

    {
      name: 'get_request',
      description: 'Get full details (request + response body) for a captured request id.',
      inputSchema: z.object({ reqId: z.string() }),
      handler: async (args) => bridge.call('get_request', args)
    },

    {
      name: 'mock_from_request',
      description: 'Build a fulfill rule from a previously-captured request, optionally deep-merging a patch into its JSON body. Most common AI-driven flow: `tail_requests` → pick id → `mock_from_request` with the patch.',
      inputSchema: z.object({
        reqId: z.string(),
        patch: z.record(z.any()).optional().describe('Object deep-merged into original JSON response before storing as the mock body.')
      }),
      handler: async (args) => bridge.call('mock_from_request', args)
    }
  ];
}
