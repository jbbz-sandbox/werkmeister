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

### Mods

| Mod | What it does |
|-----|--------------|
| `/workspaces` | Opens by itself when an interactive session starts in a folder of workspaces (one whose child holds `.sandbox/workspace.yml`, e.g. `~/features`). A docked pane with one card per workspace: border colour by state, task title, issue ID, description, work type, current ICM stage (the first `stages/*/output/` still empty) — or, once PR files exist, the lifecycle state (ready to open, PR open k/n, merged — awaiting release, shipped — close out; docs/workspace-lifecycle.md) — container counts, the Claude working/waiting flag coloured at the header's right edge, and the newest Claude session title with where it lives (Desktop, VS Code, CLI). Up / Stop / Restart / Down / Remove run sandbox-core in a `node` child (a plugin's call to its own MCP server is refused by the desktop's auto mode; a host process is not); Remove asks twice. ↻ PRs (while a PR is open or merged) runs `sandbox pr status`; ✓ Close out (once shipped) runs `sandbox close-out` and asks twice. ＋ New session opens a new Claude Code Desktop session in the workspace folder (`claude://code/new?folder=…`, the link the app's Finder service uses). ↗ Continue in Desktop / VS Code / Terminal picks up the newest session where it lives: it focuses the Desktop session (or opens its own link), opens the folder in VS Code for a VS Code session, else resumes it in a Terminal window. ⇆ Open beside shows the session in split view next to this one so the pane stays in sight. It appears only for a session this one started (its `startedBy`), the only kind the app will split. A Workspaces | ＋ Create tab bar heads the pane; on the Workspaces tab, ☐ Focus shows only workspaces whose `.sandbox/workspace.yml` `labels` include `focus`, and the choice survives a plugin reload. The Create tab draws the workspace form from the same schema as the browser form (fields, grouped checkbox columns, a multi-line starting prompt with Refine with Claude) with a button that fills empty fields from the issue, and creates the workspace directly. A desktop session that starts inside a workspace files itself under the sidebar group named `Feature Workspaces`, if that group exists and the session is in no group yet (`ccd_sidebar` `move_sessions`). The `workspace_form` tool lets Claude fill the form from the prompt box (where pasting works); it never creates the workspace. Source: [`hooks/register.tsx`](hooks/register.tsx). |

Probe findings (2026-10-09): `change_directory` from a plugin call: yes, after the person approves the folder. `claude://` link in a pane focuses the session: no, the desktop pane draws nothing for it. Fallback taken: the session entry is text plus a Jump button that calls `ccd_window` `open_session_in`, which only focuses sessions this one started; otherwise it toasts the title to open from the sidebar.

To load it from a checkout instead of the marketplace, set `CLAUDE_CODE_PLUGIN_DIRS` to this folder in the `env` block of `~/.claude/settings.json`.

### Code standards (`sb-*`) — NOT in this plugin

The `sb-implement` / `sb-research` entry skills and the `sb-*-standard` code
standards are **not shipped here**. They are projected into each workspace's
`.claude/skills/` by `sandbox init-workspace`: entry-skill sources live in
[`apps/cli/infra/skills/`](../../apps/cli/infra/skills), and the standards are
generated from [jbbz-sandbox/sandbox-standards](https://github.com/jbbz-sandbox/sandbox-standards) by
`sandbox standards build` (drift-gated by `sandbox standards check`).

## Bundled MCP server (`sandbox-workspace`)

The plugin's [`.mcp.json`](./.mcp.json) auto-wires an MCP server (`sandbox dashboard`,
source in [`apps/sandbox-dashboard`](../../apps/sandbox-dashboard)) exposing ~26 tools —
workspace create/manage, PR review, issue lookups, k8s/kube health, and a Claude
session bridge — with **one form definition and graceful UI degradation per client**:

| Surface | How it connects | UI |
|---------|-----------------|----|
| **Claude Desktop** | `claude_desktop_config.json` (Desktop doesn't install plugins) | Inline MCP App (`ui://`): create form + workspace dashboard |
| **Cowork** | `install-workspace-dashboard` skill | Live artifact dashboard |
| **Claude Code CLI / VS Code** | this plugin's `.mcp.json` | Localhost browser: dashboard (`open-workspaces-ui`) + blocking create form |

The server detects whether the client renders MCP App UI (`io.modelcontextprotocol/ui`
capability); every tool also returns markdown/text, so any host degrades gracefully.
Call the create tool directly: `mcp__plugin_sandbox-tools_sandbox-workspace__workspace` (optionally
`{ "issue": "<issue ID>" }`). Full tool table in the
[app README](../../apps/sandbox-dashboard/README.md).

### Register on Claude Desktop
Plugins don't install in Desktop, so add the same server to
`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{ "mcpServers": { "sandbox-workspace": { "command": "sandbox", "args": ["dashboard"] } } }
```

## Dependencies

- **MCP server build:** run `cd apps/sandbox-dashboard && npm run build` once — `sandbox dashboard`
  runs the compiled `dist/main.js`. Without it, the server won't start.
- The `sandbox` CLI must be on `PATH` (e.g. `~/.local/bin/sandbox`), and Docker running.
- **Self-contained:** the workspace form and its "Refine with Claude" / issue-fetch logic
  live in [`apps/sandbox-dashboard`](../../apps/sandbox-dashboard) — no external skill is required.
  Issues come from the tracker picked in `sandbox setup`; refine uses the local `claude` CLI.

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
