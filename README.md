# github-issues-mcp

A zero-dependency MCP server that gives Claude full control over GitHub Issues and Project boards. OAuth 2.0 auth, Streamable HTTP transport, runs anywhere Node.js 18+ runs.

Built for developers who want Claude (Web App, Desktop, or CLI) to manage their GitHub issue boards without installing heavyweight tools or granting broad permissions.

## Use Case

You have a private GitHub repo with issues organized as a project board (kanban). You want Claude — across Web App, Desktop, and CLI — to:

- **Read** your board: list issues, check statuses, filter by label
- **Write** to it: create issues, update them, add comments, close them
- **Manage the kanban**: move items between columns (Todo, In Progress, Done)

The official GitHub MCP connector (via `api.githubcopilot.com`) requires GitHub App installation with org-level permissions and doesn't reliably access private repos under personal accounts. This server sidesteps all of that — it uses a GitHub Personal Access Token directly. If the token can see the repo, Claude can manage it.

**Real-world example:** I use this to manage a multi-project roadmap across Claude Web App (for planning conversations) and Claude Code CLI (for implementation sessions). Both Claudes read and write to the same kanban board. Issues are created during planning, moved to "In Progress" during coding, and closed when done — all without leaving the conversation.

## Features

- **10 tools**: issues (list, get, create, update, comment, labels) + projects (get board, list items, add item, move between columns)
- **OAuth 2.0 + PKCE**: proper authorization flow with consent screen and admin secret
- **GitHub Projects V2**: full kanban board management via GraphQL API
- **Streamable HTTP**: MCP transport that works with Claude Web App custom connectors
- **Zero npm dependencies**: just Node.js built-ins (http, crypto)
- **Self-hosted**: runs on your own server, you control the data flow
- **~500 lines**: read the whole thing in 15 minutes

## Quick Start

### 1. Generate secrets

```bash
# Admin secret for OAuth consent screen
openssl rand -hex 24
```

### 2. Create a GitHub token

Go to **GitHub** > **Settings** > **Developer settings** > **Personal access tokens** > **Tokens (classic)**

Select scopes: `repo` + `project`

### 3. Run the server

```bash
GITHUB_TOKEN=ghp_your_token \
MCP_ADMIN_SECRET=your_admin_secret \
MCP_BASE_URL=https://mcp.yourdomain.com \
node server.js
```

### 4. Put it behind HTTPS

The server binds to `127.0.0.1:3232` by default. Use a reverse proxy for HTTPS:

**Caddy:**
```
mcp.yourdomain.com {
    reverse_proxy localhost:3232
}
```

### 5. Connect Claude Web App

1. Go to **claude.ai/settings/connectors**
2. Click **Add custom connector**
3. Enter URL: `https://mcp.yourdomain.com/mcp`
4. Claude will redirect to the consent screen
5. Enter your admin secret to authorize
6. Done — Claude can now manage your GitHub issues and project boards

### 6. Connect Claude Code CLI

```bash
claude mcp add --transport http github-issues https://mcp.yourdomain.com/mcp
```

Claude Code will go through the same OAuth flow on first use.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_TOKEN` | Yes | — | GitHub Personal Access Token with `repo` + `project` scopes |
| `MCP_ADMIN_SECRET` | Yes | — | Secret for the OAuth consent screen |
| `MCP_BASE_URL` | Yes | — | Public HTTPS URL of your server |
| `MCP_PORT` | No | `3232` | HTTP port |
| `MCP_HOST` | No | `127.0.0.1` | Bind address |

## Deploy with systemd

```ini
[Unit]
Description=GitHub Issues MCP Server
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/github-issues-mcp
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=MCP_PORT=3232
Environment=MCP_BASE_URL=https://mcp.yourdomain.com
Environment=GITHUB_TOKEN=ghp_your_token
Environment=MCP_ADMIN_SECRET=your_secret

[Install]
WantedBy=multi-user.target
```

## Tools

### Issues

| Tool | Description |
|------|-------------|
| `list_issues` | List open/closed/all issues, filter by labels |
| `get_issue` | Get full issue details including body and comments count |
| `create_issue` | Create a new issue with title, body, and labels |
| `update_issue` | Update title, body, state, or labels on an existing issue |
| `add_comment` | Add a markdown comment to an issue |
| `list_labels` | List all labels in a repository |

### Projects (Kanban)

| Tool | Description |
|------|-------------|
| `get_project` | Get a project board with its status columns and field IDs |
| `list_project_items` | List all items in a project with their current column/status |
| `add_to_project` | Add an issue to a project board |
| `move_project_item` | Move an item between columns (e.g., Todo → In Progress → Done) |

## OAuth Flow

The server implements OAuth 2.0 Authorization Code with PKCE:

1. Claude discovers endpoints via `/.well-known/oauth-authorization-server`
2. Claude registers dynamically via `/register`
3. Claude redirects to `/authorize` — you see a consent screen
4. You enter your admin secret and click Authorize
5. Claude exchanges the code for a token at `/token`
6. All subsequent MCP requests use the Bearer token

Tokens expire after 24 hours. Re-authorization is automatic.

## Architecture

```
Claude (Web/Desktop/CLI)
    |
    |-- OAuth flow (one-time)
    |   |-- GET  /.well-known/oauth-authorization-server
    |   |-- POST /register
    |   |-- GET  /authorize  -->  consent screen  -->  POST /authorize
    |   +-- POST /token      -->  access_token
    |
    +-- MCP requests (Bearer token)
        +-- POST /mcp  -->  tools/list, tools/call
                              |
                              |-- GitHub REST API (issues, labels)
                              +-- GitHub GraphQL API (projects, kanban)
                                  (your Personal Access Token)
```

## Security

- **Admin secret**: only someone who knows the secret can authorize new sessions
- **PKCE**: prevents authorization code interception
- **Token expiry**: access tokens expire after 24 hours
- **Localhost binding**: server only listens on 127.0.0.1, HTTPS via reverse proxy
- **Body size limit**: 16KB max on all endpoints
- **No state on disk**: all OAuth state is in-memory, restarts invalidate all sessions

## License

MIT — Use it, modify it, ship it.

---

Built by [ZeroDeps](https://github.com/zerodeps-dev) — Zero npm dependencies.
