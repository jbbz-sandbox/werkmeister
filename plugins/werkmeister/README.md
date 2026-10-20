# werkmeister

A Claude Code plugin bundling the diagnostic and operations skills for the
sandbox environment.

## Skills

### Diagnostics & operations
| Skill | What it does |
|-------|--------------|
| `status` | Comprehensive health overview of the whole sandbox (containers, networks, proxy). |
| `diagnose` | Full-stack health checks across containers, networking, Caddy routing, and connectivity. |
| `routing-test` | Trace a single URL through the routing chain to find where it breaks. |
| `caddy-reload` | Validate, reload, and smoke-test the Caddy proxy config safely. |

### Workspace lifecycle
| Skill | What it does |
|-------|--------------|
| `workspace` | Create a brand-new workspace (git worktrees + init). Uses the bundled **`workspaces` MCP server** (see below) for the form; falls back to the direct CLI. Self-contained — no external skill dependency. |
| `feature-test` | Start a feature environment and open a headed Playwright browser for interactive testing. |
| `starting-prompt` | Run the `starting_prompt` defined in the workspace's `.sandbox/workspace.yml`. |
| `install-workspace-dashboard` | Install the Sandbox Workspaces live dashboard as a **Cowork artifact** (`apps/sandbox-dashboard/dist/workspace-list.artifact.html`). |

### Mods

| Mod | What it does |
|-----|--------------|
| `/workspaces` | Opens by itself when an interactive session starts in a folder of workspaces (one whose child holds `.sandbox/workspace.yml`, e.g. `~/features`). A docked pane with one card per workspace: border colour by state, task title, issue ID, description, work type, current ICM stage (the first `stages/*/output/` still empty) — or, once PR files exist, the lifecycle state (ready to open, PR open k/n, merged — awaiting release, shipped — close out; docs/workspace-lifecycle.md) — container counts, the Claude working/waiting flag coloured at the header's right edge, and the newest Claude session title with where it lives (Desktop, VS Code, CLI). Up / Stop / Restart / Down run sandbox-core in a `node` child (a plugin's call to its own MCP server is refused by the desktop's auto mode; a host process is not). ↻ PRs (while a PR is open or merged) runs `sandbox pr status`. Each card has one end button, `sandbox close-out`, the single end-of-workspace verb (docs/workspace-lifecycle.md): ✓ Close out once every PR shipped, else ✕ Abandon…, which asks for the reason in the pane. Both ask twice, then archive every desktop session whose cwd is in the workspace (`ccd_session_mgmt` `archive_session`; a refused one is reported as left open) and list terminal sessions still open there to `/exit`. The same archive runs after a successful `close-out` MCP tool call, through a `tool.call` hook, since that server can't reach the app's session tools. ＋ New session opens a new Claude Code Desktop session in the workspace folder (`claude://code/new?folder=…`, the link the app's Finder service uses). ↗ Continue in Desktop / VS Code / Terminal picks up the newest session where it lives: it focuses the Desktop session (or opens its own link), opens the folder in VS Code for a VS Code session, else resumes it in a Terminal window. ⇆ Open beside shows the session in split view next to this one so the pane stays in sight. It appears only for a session this one started (its `startedBy`), the only kind the app will split. 📌 Pin / Unpin pins or unpins that session in the app's sidebar (`ccd_sidebar` `set_pinned`; desktop only). A Workspaces | ＋ Create tab bar heads the pane; on the Workspaces tab, ☐ Focused only shows only workspaces whose `.sandbox/workspace.yml` `labels` include `focus`, and the choice survives a plugin reload. The Create tab draws the workspace form from the same schema as the browser form (fields, grouped checkbox columns, a multi-line starting prompt with Refine with Claude) with a button that fills empty fields from the issue, and creates the workspace directly. A desktop session that starts inside a workspace files itself under the sidebar group named `Feature Workspaces`, if that group exists and the session is in no group yet (`ccd_sidebar` `move_sessions`). The `workspace_form` tool lets Claude fill the form from the prompt box (where pasting works); it never creates the workspace. Source: [`hooks/register.tsx`](hooks/register.tsx). |

Probe findings (2026-10-09): `change_directory` from a plugin call: yes, after the person approves the folder. `claude://` link in a pane focuses the session: no, the desktop pane draws nothing for it. Fallback taken: the session entry is text plus a Jump button that calls `ccd_window` `open_session_in`, which only focuses sessions this one started; otherwise it toasts the title to open from the sidebar.

To load it from a checkout instead of the marketplace, set `CLAUDE_CODE_PLUGIN_DIRS` to this folder in the `env` block of `~/.claude/settings.json`.

### Code standards (`sb-*`) — NOT in this plugin

The `sb-implement` / `sb-research` entry skills and the `sb-*-standard` code
standards are **not shipped here**. They are projected into each workspace's
`.claude/skills/` by `sandbox init-workspace`: entry-skill sources live in
[`apps/cli/infra/skills/`](../../apps/cli/infra/skills), and the standards are
generated from [jbbz-sandbox/sandbox-standards](https://github.com/jbbz-sandbox/sandbox-standards) by
`sandbox standards build` (drift-gated by `sandbox standards check`).

## Bundled MCP server (`workspaces`)

The plugin's [`.mcp.json`](./.mcp.json) auto-wires an MCP server (`w9r dashboard`,
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
Call the create tool directly: `mcp__plugin_werkmeister_workspaces__workspace` (optionally
`{ "issue": "<issue ID>" }`). Full tool table in the
[app README](../../apps/sandbox-dashboard/README.md).

### Register on Claude Desktop
Plugins don't install in Desktop, so add the same server to
`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{ "mcpServers": { "workspaces": { "command": "w9r", "args": ["dashboard"] } } }
```

## Dependencies

- **MCP server build:** run `cd apps/sandbox-dashboard && npm run build` once — `w9r dashboard`
  runs the compiled `dist/main.js`. Without it, the server won't start.
- The `w9r` CLI (package `werkmeister` 0.14 or later) must be on `PATH`, and Docker running.
- **Self-contained:** the workspace form and its "Refine with Claude" / issue-fetch logic
  live in [`apps/sandbox-dashboard`](../../apps/sandbox-dashboard) — no external skill is required.
  Issues come from the tracker picked in `sandbox setup`; refine uses the local `claude` CLI.

## Install

This repo doubles as a plugin marketplace. From any Claude Code session
(installs at user scope, so the skills + workspace MCP server are available in
every session, not just inside this repo):

```
/plugin marketplace add jbbz-sandbox/werkmeister
/plugin install werkmeister@werkmeister
```

Skills are namespaced by the plugin: `/werkmeister:diagnose`, `/werkmeister:workspace`, …

To develop/test locally from a checkout:

```
/plugin marketplace add /path/to/werkmeister
/plugin install werkmeister@werkmeister
```

Validate changes before committing:

```
claude plugin validate ./plugins/werkmeister
claude plugin validate .   # validates the marketplace manifest
```

## Migrating from `sandbox-tools`

SW-9 renamed the plugin, the marketplace, the skills and the MCP servers. Claude Code has no
alias for a renamed plugin, and an already-added `sandbox` marketplace stops resolving
`sandbox-tools` once its manifest says `werkmeister` (an update reports success, then
`Plugin "sandbox-tools" not found`), so an old install does not move on its own.

| Was | Is |
|-----|----|
| plugin `sandbox-tools` | `werkmeister` |
| marketplace `sandbox` | `werkmeister` (install id `werkmeister@werkmeister`) |
| skills `sandbox-workspace`, `sandbox-diagnose`, `sandbox-feature-test`, `sandbox-status`, `sandbox-caddy-reload`, `sandbox-routing-test`, `sandbox-starting-prompt` | `/werkmeister:workspace`, `:diagnose`, `:feature-test`, `:status`, `:caddy-reload`, `:routing-test`, `:starting-prompt` |
| plugin MCP server `sandbox-workspace` (`mcp__plugin_sandbox-tools_sandbox-workspace__*`) | `workspaces` (`mcp__plugin_werkmeister_workspaces__*`) |
| Claude Desktop entry `"sandbox-workspace"` (`mcp__sandbox-workspace__*`) | `"workspaces"` (`mcp__workspaces__*`) |
| registry MCP server `sandbox`, tools `sandbox-up`, `sandbox-status`, `sandbox-workspace`, … | `werkmeister`, tools `up`, `status`, `workspace`, … (every `sandbox-` prefix dropped) |

**One step:** update the CLI to `werkmeister` 0.14 or later, then run

```
w9r setup
```

It adds the `werkmeister` marketplace, installs `werkmeister@werkmeister`, and only then
uninstalls `sandbox-tools@sandbox` and removes the `sandbox` marketplace.
`w9r setup --check` lists an old install as a failed step until you do. `init-workspace` also warns
about it.

**By hand**, in a Claude Code session:

```
/plugin marketplace add jbbz-sandbox/werkmeister
/plugin install werkmeister@werkmeister
/plugin uninstall sandbox-tools@sandbox
/plugin marketplace remove sandbox
```

**Checkout installs** that set `CLAUDE_CODE_PLUGIN_DIRS` to `.../plugins/sandbox-tools` keep
working for one release: that path is now a link to `plugins/werkmeister` and loads the plugin
under its new name. Point it at `.../plugins/werkmeister`, and rename the `sandbox` entry in
`extraKnownMarketplaces` to `werkmeister` (or delete it), before the link is removed.

**Also update by hand:**
- Claude Desktop: in `claude_desktop_config.json`, rename the `sandbox-workspace` server to
  `workspaces` and set its command to `w9r`.
- Anything of yours that names the old tools or skills (permission rules in your own settings,
  prompts that say `/sandbox-diagnose`).

**Compatibility for one release:** the generated workspace permission rules allow both the old
and the new `mcp__plugin_…` prefixes, so a machine that has not run `w9r setup` yet keeps working. The
old `sandbox` entry in a workspace's `.mcp.json` is dropped at the next `init-workspace`.
