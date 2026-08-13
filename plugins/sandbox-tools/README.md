# sandbox-tools

A Claude Code plugin bundling the diagnostic and operations skills for the
sandbox environment.

## Skills

### Diagnostics & operations
| Skill | What it does |
|-------|--------------|
| `sandbox-status` | Comprehensive health overview of the whole sandbox (containers, networks, proxy). |
| `sandbox-diagnose` | Full-stack health checks across containers, networking, Caddy routing, and connectivity. |
| `sandbox-routing-test` | Trace a single URL through the routing chain to find where it breaks. |
| `sandbox-caddy-reload` | Validate, reload, and smoke-test the Caddy proxy config safely. |

### Workspace lifecycle
| Skill | What it does |
|-------|--------------|
| `sandbox-workspace` | Create a brand-new workspace (git worktrees + init). Uses the bundled **`sandbox-workspace` MCP server** (see below) for the form; falls back to the direct CLI. Self-contained — no external skill dependency. |
| `sandbox-feature-test` | Start a feature environment and open a headed Playwright browser for interactive testing. |
| `sandbox-starting-prompt` | Run the `starting_prompt` defined in the workspace's `.sandbox/workspace.yml`. |
| `install-workspace-dashboard` | Install the Sandbox Workspaces live dashboard as a **Cowork artifact** (`apps/sandbox-dashboard/dist/workspace-list.artifact.html`). |

### Code standards (`sb-*`) — NOT in this plugin

The `sb-implement` / `sb-research` entry skills and the `sb-*-standard` code
standards are **not shipped here**. They are projected into each workspace's
`.claude/skills/` by `sandbox init-workspace`: entry-skill sources live in
[`apps/cli/infra/skills/`](../../apps/cli/infra/skills), and the standards are
generated from [jbbz-sandbox/sandbox-standards](https://github.com/jbbz-sandbox/sandbox-standards) by
`sandbox standards build` (drift-gated by `sandbox standards check`).

## Bundled MCP server (`sandbox-workspace`)

The plugin's [`.mcp.json`](./.mcp.json) auto-wires an MCP server (`sandbox mcp --stdio`,
source in [`apps/sandbox-dashboard`](../../apps/sandbox-dashboard)) exposing ~26 tools —
workspace create/manage, PR review, Jira lookups, k8s/kube health, and a Claude
session bridge — with **one form definition and graceful UI degradation per client**:

| Surface | How it connects | UI |
|---------|-----------------|----|
| **Claude Desktop** | `claude_desktop_config.json` (Desktop doesn't install plugins) | Inline MCP App (`ui://`): create form + workspace dashboard |
| **Cowork** | `install-workspace-dashboard` skill | Live artifact dashboard |
| **Claude Code CLI / VS Code** | this plugin's `.mcp.json` | Localhost browser: dashboard (`open-workspaces-ui`) + blocking create form |

The server detects whether the client renders MCP App UI (`io.modelcontextprotocol/ui`
capability); every tool also returns markdown/text, so any host degrades gracefully.
Call the create tool directly: `mcp__sandbox-workspace__workspace` (optionally
`{ "jira": "PROJ-1234" }`). Full tool table in the
[app README](../../apps/sandbox-dashboard/README.md).

### Register on Claude Desktop
Plugins don't install in Desktop, so add the same server to
`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{ "mcpServers": { "sandbox-workspace": { "command": "sandbox", "args": ["mcp", "--stdio"] } } }
```

## Dependencies

- **MCP server build:** run `cd apps/sandbox-dashboard && npm run build` once — `sandbox mcp`
  runs the compiled `dist/main.js`. Without it, the server won't start.
- The `sandbox` CLI must be on `PATH` (e.g. `~/.local/bin/sandbox`), and Docker running.
- **Self-contained:** the workspace form and its "Refine with Claude" / Jira-fetch logic
  live in [`apps/sandbox-dashboard`](../../apps/sandbox-dashboard) — no external skill is required.
  Jira fetch/refine uses the local `claude` CLI's Atlassian MCP.

## Install

This repo doubles as a plugin marketplace. From any Claude Code session
(installs at user scope, so the skills + workspace MCP server are available in
every session, not just inside this repo):

```
/plugin marketplace add jbbz-sandbox/sandbox
/plugin install sandbox-tools@sandbox
```

To develop/test locally from a checkout:

```
/plugin marketplace add /path/to/sandbox
/plugin install sandbox-tools@sandbox
```

Validate changes before committing:

```
claude plugin validate ./plugins/sandbox-tools
claude plugin validate .   # validates the marketplace manifest
```
