#!/usr/bin/env node

/**
 * github-issues-mcp — A zero-dependency MCP server for GitHub Issues
 *
 * Connects Claude (Web App, Desktop, CLI) to GitHub Issues via the
 * Model Context Protocol over Streamable HTTP with OAuth 2.0 auth.
 *
 * Zero npm dependencies. Just Node.js 18+.
 *
 * https://github.com/zerodeps-dev/github-issues-mcp
 */

import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';

// ── Configuration ───────────────────────────────────────────────────────────

const CONFIG = {
  port: parseInt(process.env.MCP_PORT || '3232'),
  host: process.env.MCP_HOST || '127.0.0.1',
  baseUrl: process.env.MCP_BASE_URL || 'http://localhost:3232',
  githubToken: process.env.GITHUB_TOKEN || '',
  adminSecret: process.env.MCP_ADMIN_SECRET || '',
  // Static API key for CLI clients that can't do browser OAuth
  staticApiKey: process.env.MCP_STATIC_API_KEY || '',
};

// ── OAuth 2.0 State ─────────────────────────────────────────────────────────

const authCodes = new Map();    // code -> { clientId, codeChallenge, redirectUri, expiresAt }
const accessTokens = new Map(); // token -> { clientId, expiresAt }
const clients = new Map();      // clientId -> { clientSecret, redirectUris }

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of authCodes) if (now > v.expiresAt) authCodes.delete(k);
  for (const [k, v] of accessTokens) if (now > v.expiresAt) accessTokens.delete(k);
}, 5 * 60 * 1000);

// ── GitHub API ──────────────────────────────────────────────────────────────

async function ghApi(method, path, body = null) {
  const opts = {
    method,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + CONFIG.githubToken,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'github-issues-mcp/1.0',
    },
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch('https://api.github.com' + path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'GitHub API ' + res.status);
  return data;
}

// ── GitHub GraphQL API ──────────────────────────────────────────────────────

async function ghGraphQL(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + CONFIG.githubToken,
      'Content-Type': 'application/json',
      'User-Agent': 'github-issues-mcp/1.0',
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) throw new Error(data.errors.map(e => e.message).join(', '));
  return data.data;
}

// ── MCP Tools ───────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_issues',
    description: 'List issues in a GitHub repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        labels: { type: 'string', description: 'Comma-separated label filter (optional)' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get details of a specific issue',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'number', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body (markdown)' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels to apply' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'update_issue',
    description: 'Update an existing issue',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'number', description: 'Issue number' },
        title: { type: 'string', description: 'New title' },
        body: { type: 'string', description: 'New body' },
        state: { type: 'string', enum: ['open', 'closed'] },
        labels: { type: 'array', items: { type: 'string' } },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'add_comment',
    description: 'Add a comment to an issue',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'number', description: 'Issue number' },
        body: { type: 'string', description: 'Comment body (markdown)' },
      },
      required: ['owner', 'repo', 'issue_number', 'body'],
    },
  },
  {
    name: 'list_labels',
    description: 'List all labels in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_project',
    description: 'Get a GitHub Project board with its status columns and field IDs',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Project owner (user or org)' },
        project_number: { type: 'number', description: 'Project number' },
        owner_type: { type: 'string', enum: ['user', 'organization'], default: 'user', description: 'Whether owner is a user or org' },
      },
      required: ['owner', 'project_number'],
    },
  },
  {
    name: 'list_project_items',
    description: 'List all items in a GitHub Project with their status/column',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project node ID (from get_project)' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'add_to_project',
    description: 'Add an issue to a GitHub Project board',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project node ID' },
        issue_owner: { type: 'string', description: 'Repository owner' },
        issue_repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'number', description: 'Issue number' },
      },
      required: ['project_id', 'issue_owner', 'issue_repo', 'issue_number'],
    },
  },
  {
    name: 'move_project_item',
    description: 'Move a project item to a different status column (e.g., Todo, In Progress, Done)',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project node ID' },
        item_id: { type: 'string', description: 'Project item node ID (from list_project_items)' },
        field_id: { type: 'string', description: 'Status field node ID (from get_project)' },
        option_id: { type: 'string', description: 'Status option ID for the target column (from get_project)' },
      },
      required: ['project_id', 'item_id', 'field_id', 'option_id'],
    },
  },
];

async function executeTool(name, args) {
  switch (name) {
    case 'list_issues': {
      let path = '/repos/' + args.owner + '/' + args.repo + '/issues?state=' + (args.state || 'open') + '&per_page=100';
      if (args.labels) path += '&labels=' + encodeURIComponent(args.labels);
      const issues = await ghApi('GET', path);
      return issues.map(i => ({
        number: i.number, title: i.title, state: i.state,
        labels: i.labels.map(l => l.name),
        created_at: i.created_at, url: i.html_url,
      }));
    }
    case 'get_issue': {
      const i = await ghApi('GET', '/repos/' + args.owner + '/' + args.repo + '/issues/' + args.issue_number);
      return {
        number: i.number, title: i.title, body: i.body, state: i.state,
        labels: i.labels.map(l => l.name),
        created_at: i.created_at, updated_at: i.updated_at,
        comments: i.comments, url: i.html_url,
      };
    }
    case 'create_issue': {
      const payload = { title: args.title };
      if (args.body) payload.body = args.body;
      if (args.labels) payload.labels = args.labels;
      const i = await ghApi('POST', '/repos/' + args.owner + '/' + args.repo + '/issues', payload);
      return { number: i.number, title: i.title, url: i.html_url };
    }
    case 'update_issue': {
      const payload = {};
      if (args.title) payload.title = args.title;
      if (args.body) payload.body = args.body;
      if (args.state) payload.state = args.state;
      if (args.labels) payload.labels = args.labels;
      const i = await ghApi('PATCH', '/repos/' + args.owner + '/' + args.repo + '/issues/' + args.issue_number, payload);
      return { number: i.number, title: i.title, state: i.state, url: i.html_url };
    }
    case 'add_comment': {
      const c = await ghApi('POST', '/repos/' + args.owner + '/' + args.repo + '/issues/' + args.issue_number + '/comments', { body: args.body });
      return { id: c.id, url: c.html_url };
    }
    case 'list_labels': {
      const labels = await ghApi('GET', '/repos/' + args.owner + '/' + args.repo + '/labels?per_page=100');
      return labels.map(l => ({ name: l.name, color: l.color, description: l.description }));
    }
    case 'get_project': {
      const ownerType = args.owner_type || 'user';
      const query = 'query($login: String!, $number: Int!) { '
        + ownerType + '(login: $login) { projectV2(number: $number) { '
        + 'id title url '
        + 'fields(first: 50) { nodes { '
        + '... on ProjectV2FieldCommon { id name } '
        + '... on ProjectV2SingleSelectField { id name options { id name } } '
        + '... on ProjectV2IterationField { id name } '
        + '} } } } }';
      const data = await ghGraphQL(query, { login: args.owner, number: args.project_number });
      const project = data[ownerType]?.projectV2;
      if (!project) throw new Error('Project not found');
      return {
        id: project.id,
        title: project.title,
        url: project.url,
        fields: project.fields.nodes.filter(f => f.id).map(f => ({
          id: f.id, name: f.name,
          options: f.options || undefined,
        })),
      };
    }
    case 'list_project_items': {
      const query = 'query($id: ID!) { node(id: $id) { ... on ProjectV2 { '
        + 'items(first: 100) { nodes { id '
        + 'fieldValues(first: 10) { nodes { '
        + '... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } } '
        + '... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } } '
        + '} } '
        + 'content { ... on Issue { number title state labels(first: 10) { nodes { name } } url } '
        + '... on PullRequest { number title state url } } '
        + '} } } } }';
      const data = await ghGraphQL(query, { id: args.project_id });
      const items = data.node?.items?.nodes || [];
      return items.map(item => {
        const fields = {};
        for (const fv of item.fieldValues.nodes) {
          if (fv.field?.name) {
            fields[fv.field.name] = fv.name || fv.text || null;
          }
        }
        return {
          item_id: item.id,
          status: fields['Status'] || 'No Status',
          fields,
          content: item.content ? {
            number: item.content.number,
            title: item.content.title,
            state: item.content.state,
            labels: item.content.labels?.nodes?.map(l => l.name) || [],
            url: item.content.url,
          } : null,
        };
      });
    }
    case 'add_to_project': {
      // First get the issue's node ID
      const issueData = await ghGraphQL(
        'query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { issue(number: $number) { id } } }',
        { owner: args.issue_owner, repo: args.issue_repo, number: args.issue_number }
      );
      const contentId = issueData.repository?.issue?.id;
      if (!contentId) throw new Error('Issue not found');

      const mutation = 'mutation($projectId: ID!, $contentId: ID!) { addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) { item { id } } }';
      const result = await ghGraphQL(mutation, { projectId: args.project_id, contentId });
      return { item_id: result.addProjectV2ItemById.item.id };
    }
    case 'move_project_item': {
      const mutation = 'mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) { '
        + 'updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, '
        + 'value: { singleSelectOptionId: $optionId } }) { projectV2Item { id } } }';
      const result = await ghGraphQL(mutation, {
        projectId: args.project_id,
        itemId: args.item_id,
        fieldId: args.field_id,
        optionId: args.option_id,
      });
      return { success: true, item_id: result.updateProjectV2ItemFieldValue.projectV2Item.id };
    }
    default:
      throw new Error('Unknown tool: ' + name);
  }
}

// ── MCP Protocol ────────────────────────────────────────────────────────────

function handleMcp(msg) {
  const { method, id } = msg;
  switch (method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'github-issues-mcp', version: '1.0.0' },
      }};
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'notifications/initialized':
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown method: ' + method } };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseQuery(url) {
  const q = {};
  const idx = url.indexOf('?');
  if (idx < 0) return q;
  for (const pair of url.slice(idx + 1).split('&')) {
    const [k, ...rest] = pair.split('=');
    q[decodeURIComponent(k)] = decodeURIComponent(rest.join('='));
  }
  return q;
}

async function parseFormBody(req) {
  let body = '';
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new Error('Body too large');
    body += chunk;
  }
  const q = {};
  for (const pair of body.split('&')) {
    const [k, ...rest] = pair.split('=');
    q[decodeURIComponent(k)] = decodeURIComponent(rest.join('='));
  }
  return q;
}

async function parseJsonBody(req) {
  let body = '';
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new Error('Body too large');
    body += chunk;
  }
  return body ? JSON.parse(body) : {};
}

function verifyPkce(verifier, challenge) {
  const hash = createHash('sha256').update(verifier).digest('base64url');
  return hash === challenge;
}

function sendJson(res, data, status = 200, extraHeaders = {}) {
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(data));
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// ── CORS ────────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

// ── Consent Page HTML ───────────────────────────────────────────────────────

function consentPage(clientId, redirectUri, state, codeChallenge, codeChallengeMethod) {
  return '<!DOCTYPE html>\n'
    + '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n'
    + '<title>Authorize — GitHub Issues MCP</title>\n'
    + '<style>\n'
    + '  body { font-family: system-ui, sans-serif; background: #0f1117; color: #e4e6ed; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }\n'
    + '  .card { background: #1a1d27; border: 1px solid #2a2e3d; border-radius: 12px; padding: 32px; max-width: 400px; width: 100%; }\n'
    + '  h1 { font-size: 20px; margin: 0 0 8px; }\n'
    + '  p { color: #8b8fa3; font-size: 14px; margin: 0 0 24px; }\n'
    + '  label { display: block; font-size: 12px; font-weight: 600; color: #8b8fa3; margin-bottom: 4px; }\n'
    + '  input { width: 100%; padding: 10px 12px; background: #0f1117; border: 1px solid #2a2e3d; border-radius: 6px; color: #e4e6ed; font-size: 14px; box-sizing: border-box; }\n'
    + '  input:focus { border-color: #10b981; outline: none; }\n'
    + '  button { width: 100%; padding: 12px; background: #10b981; color: white; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 16px; }\n'
    + '  button:hover { opacity: 0.9; }\n'
    + '</style></head><body>\n'
    + '<div class="card">\n'
    + '  <h1>GitHub Issues MCP</h1>\n'
    + '  <p>Authorize Claude to manage your GitHub issues.</p>\n'
    + '  <form method="POST" action="/authorize">\n'
    + '    <input type="hidden" name="client_id" value="' + (clientId || '') + '">\n'
    + '    <input type="hidden" name="redirect_uri" value="' + (redirectUri || '') + '">\n'
    + '    <input type="hidden" name="state" value="' + (state || '') + '">\n'
    + '    <input type="hidden" name="code_challenge" value="' + (codeChallenge || '') + '">\n'
    + '    <input type="hidden" name="code_challenge_method" value="' + (codeChallengeMethod || '') + '">\n'
    + '    <label for="secret">Admin Secret</label>\n'
    + '    <input type="password" name="secret" id="secret" placeholder="Enter your admin secret" required autofocus>\n'
    + '    <button type="submit">Authorize</button>\n'
    + '  </form>\n'
    + '</div></body></html>';
}

function deniedPage() {
  return '<!DOCTYPE html>\n'
    + '<html><head><meta charset="utf-8"><title>Denied</title>\n'
    + '<style>body{font-family:system-ui;background:#0f1117;color:#ef4444;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}h1{font-size:20px}</style>\n'
    + '</head><body><h1>Invalid admin secret</h1></body></html>';
}

// ── HTTP Server ─────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const pathname = req.url.split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  try {
    // ── OAuth Discovery ─────────────────────────────────────────────
    if (pathname === '/.well-known/oauth-authorization-server') {
      return sendJson(res, {
        issuer: CONFIG.baseUrl,
        authorization_endpoint: CONFIG.baseUrl + '/authorize',
        token_endpoint: CONFIG.baseUrl + '/token',
        registration_endpoint: CONFIG.baseUrl + '/register',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
      });
    }

    // ── Dynamic Client Registration ─────────────────────────────────
    if (pathname === '/register' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      const clientId = randomBytes(16).toString('hex');
      const clientSecret = randomBytes(32).toString('hex');
      clients.set(clientId, {
        clientSecret,
        redirectUris: body.redirect_uris || [],
      });
      return sendJson(res, {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: body.redirect_uris || [],
      }, 201);
    }

    // ── Authorization Endpoint (GET = show consent) ─────────────────
    if (pathname === '/authorize' && req.method === 'GET') {
      const q = parseQuery(req.url);
      if (q.response_type !== 'code') {
        return sendHtml(res, 400, '<h1>Invalid response_type</h1>');
      }
      return sendHtml(res, 200, consentPage(
        q.client_id, q.redirect_uri, q.state,
        q.code_challenge, q.code_challenge_method
      ));
    }

    // ── Authorization Endpoint (POST = verify secret, issue code) ───
    if (pathname === '/authorize' && req.method === 'POST') {
      const body = await parseFormBody(req);

      if (!CONFIG.adminSecret || body.secret !== CONFIG.adminSecret) {
        return sendHtml(res, 403, deniedPage());
      }

      const code = randomBytes(32).toString('hex');
      authCodes.set(code, {
        clientId: body.client_id,
        codeChallenge: body.code_challenge,
        redirectUri: body.redirect_uri,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      const sep = body.redirect_uri.includes('?') ? '&' : '?';
      const redirectUrl = body.redirect_uri + sep + 'code=' + encodeURIComponent(code) + '&state=' + encodeURIComponent(body.state || '');
      res.writeHead(302, { Location: redirectUrl });
      return res.end();
    }

    // ── Token Endpoint ──────────────────────────────────────────────
    if (pathname === '/token' && req.method === 'POST') {
      const body = await parseFormBody(req);

      if (body.grant_type !== 'authorization_code') {
        return sendJson(res, { error: 'unsupported_grant_type' }, 400);
      }

      const entry = authCodes.get(body.code);
      if (!entry || Date.now() > entry.expiresAt) {
        return sendJson(res, { error: 'invalid_grant' }, 400);
      }

      if (entry.codeChallenge && body.code_verifier) {
        if (!verifyPkce(body.code_verifier, entry.codeChallenge)) {
          return sendJson(res, { error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
        }
      }

      const client = clients.get(body.client_id);
      if (client && client.clientSecret !== body.client_secret) {
        return sendJson(res, { error: 'invalid_client' }, 401);
      }

      authCodes.delete(body.code);
      const token = randomBytes(32).toString('hex');
      accessTokens.set(token, {
        clientId: body.client_id,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      });

      return sendJson(res, {
        access_token: token,
        token_type: 'Bearer',
        expires_in: 86400,
      });
    }

    // ── Health Check ────────────────────────────────────────────────
    if (pathname === '/health' && req.method === 'GET') {
      return sendJson(res, { status: 'ok', version: '1.0.0' });
    }

    // ── MCP Endpoint (requires Bearer token or static API key) ──────
    if (pathname === '/mcp' && req.method === 'POST') {
      const auth = req.headers.authorization;
      let authorized = false;

      if (auth && auth.startsWith('Bearer ')) {
        const token = auth.slice(7);
        // Check static API key first
        if (CONFIG.staticApiKey && token === CONFIG.staticApiKey) {
          authorized = true;
        } else {
          // Check OAuth tokens
          const tokenEntry = accessTokens.get(token);
          if (tokenEntry && Date.now() <= tokenEntry.expiresAt) {
            authorized = true;
          }
        }
      }

      if (!authorized) {
        res.writeHead(401, { ...CORS, 'WWW-Authenticate': 'Bearer' });
        return res.end();
      }

      const msg = await parseJsonBody(req);

      if (msg.method === 'tools/call') {
        try {
          const result = await executeTool(msg.params.name, msg.params.arguments || {});
          return sendJson(res, {
            jsonrpc: '2.0', id: msg.id,
            result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
          });
        } catch (err) {
          return sendJson(res, {
            jsonrpc: '2.0', id: msg.id,
            result: { content: [{ type: 'text', text: 'Error: ' + err.message }], isError: true },
          });
        }
      }

      const response = handleMcp(msg);
      if (response) {
        return sendJson(res, response, 200, { 'Mcp-Session-Id': 'session' });
      }
      res.writeHead(204, CORS);
      return res.end();
    }

    // ── 404 ─────────────────────────────────────────────────────────
    sendJson(res, { error: 'Not found' }, 404);

  } catch (err) {
    console.error('[mcp] Error:', err.message);
    sendJson(res, { error: 'Internal server error' }, 500);
  }
});

server.timeout = 30000;
server.listen(CONFIG.port, CONFIG.host, () => {
  console.log('[github-issues-mcp] v1.0.0');
  console.log('[github-issues-mcp] Listening on http://' + CONFIG.host + ':' + CONFIG.port);
  console.log('[github-issues-mcp] Base URL: ' + CONFIG.baseUrl);
  console.log('[github-issues-mcp] OAuth: ' + (CONFIG.adminSecret ? 'enabled' : 'WARNING - no admin secret set'));
});
