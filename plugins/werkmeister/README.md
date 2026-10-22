# werkmeister

A Claude Code plugin bundling the diagnostic and operations skills for the
sandbox environment.

> Paths: `~/.werkmeister/` and a workspace's `.werkmeister/` are the current names. A machine or workspace set up before the rename keeps `~/.sandbox/` or `.sandbox/` instead; use whichever exists.

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
| `workspace` | Create a brand-new workspace (git worktrees + init). Uses the bundled **`werkmeister` MCP server** (see below) for the form; falls back to the direct CLI. Self-contained — no external skill dependency. |
| `feature-test` | Start a feature environment and open a headed Playwright browser for interactive testing. |
| `starting-prompt` | Run the `starting_prompt` defined in the workspace's `.werkmeister/workspace.yml`. |
| `install-workspace-dashboard` | Install the Sandbox Workspaces live dashboard as a **Cowork artifact** (`apps/sandbox-dashboard/dist/workspace-list.artifact.html`). |

### Mods

| Mod | What it does |
|-----|--------------|
| `/workspaces` | Opens by itself when an interactive session starts in a folder of workspaces (one whose child holds `.werkmeister/workspace.yml` or the older `.sandbox/workspace.yml`, e.g. `~/features`). A docked pane with one compact card per workspace (docs/ui-spec.md, `docs/design/workspace-card/design/Pane View.dc.html`), drawn from the shared display model (`hooks/display-model.ts`, a copy of `packages/sandbox-ui`'s that `packages/sandbox-ui/test/pane-copy.test.mjs` keeps in step). Line 1: the name, the agent chip (`◌ Working` · `● Needs you` · `✓ Done` · `Idle`, from SW-46's agent state), and `⚙ Auto` for an autonomous run. Line 2: work type · task from workspace.yml. Line 3, always in this order: `containers 2 of 3 up · PRs repo#12 Open · CI running · stage 4/5 implement`. The last part is the Workflow: the ICM stage, the JIT phase, or the lifecycle step (`Ready to close out`, `Awaiting release`; docs/workspace-lifecycle.md). A Needs you card quotes the question it asked, and is the only card with an amber border. `?` beside the tabs shows the legend. Below these sit the primary action by state (Continue, ✓ Close out once shipped, or ▶ Up while nothing runs), two lifecycle buttons, and `⋯` with the rest in the ui-spec order. Up / Stop / Restart / Down run sandbox-core in a `node` child (a plugin's call to its own MCP server is refused by the desktop's auto mode; a host process is not). ↻ Refresh PRs runs `sandbox pr status` and re-polls the PRs; it is also the retry when a card says `PRs unavailable`. The end verb is `sandbox close-out` (docs/workspace-lifecycle.md): ✓ Close out once every PR shipped, and ✕ Abandon…, which asks for the reason in the pane. Each confirms inline in the card before it runs, then archive every desktop session whose cwd is in the workspace (`ccd_session_mgmt` `archive_session`; a refused one is reported as left open) and list terminal sessions still open there to `/exit`. The same archive runs after a successful `close-out` MCP tool call, through a `tool.call` hook, since that server can't reach the app's session tools. ＋ New session opens a new Claude Code Desktop session in the workspace folder (`claude://code/new?folder=…`, the link the app's Finder service uses). ↗ Continue in Desktop / VS Code / Terminal picks up the newest session where it lives: it opens the Desktop session in split view beside this chat (else opens its own link, which takes this chat's place, and toasts how to split it from the sidebar), opens the folder in VS Code for a VS Code session, else resumes it in a Terminal window. ⇆ Open beside shows the session in split view next to this one so the pane stays in sight. It appears only for a session this one started (its `startedBy`), the only kind the app will split. 📌 Pin / Unpin pins or unpins that session in the app's sidebar (`ccd_sidebar` `set_pinned`; desktop only). A Workspaces | ＋ Create tab bar heads the pane; on the Workspaces tab, ☐ Focused only shows only workspaces whose `.werkmeister/workspace.yml` `labels` include `focus`, and the choice survives a plugin reload. The Create tab draws the workspace form from the same schema as the browser form (fields, grouped checkbox columns, a multi-line starting prompt with Refine with Claude) with a button that fills empty fields from the issue, and creates the workspace directly. A desktop session that starts inside a workspace files itself under the sidebar group named `Feature Workspaces`, if that group exists and the session is in no group yet (`ccd_sidebar` `move_sessions`). The `workspace_form` tool lets Claude fill the form from the prompt box (where pasting works); it never creates the workspace. Source: [`hooks/register.tsx`](hooks/register.tsx). |

Probe findings (2026-10-09): `change_directory` from a plugin call: yes, after the person approves the folder. `claude://` link in a pane focuses the session: no, the desktop pane draws nothing for it. Fallback taken: the session entry is text plus a Jump button that calls `ccd_window` `open_session_in`, which only focuses sessions this one started; otherwise it toasts the title to open from the sidebar.

To load it from a checkout instead of the marketplace, set `CLAUDE_CODE_PLUGIN_DIRS` to this folder in the `env` block of `~/.claude/settings.json`.

### Code standards (`sb-*`) — NOT in this plugin

The `sb-implement` / `sb-research` entry skills and the `sb-*-standard` code
standards are **not shipped here**. They are projected into each workspace's
`.claude/skills/` by `sandbox init-workspace`: entry-skill sources live in
[`apps/cli/infra/skills/`](../../apps/cli/infra/skills), and the standards are
rendered at the same step from the tree `overrides.standards_dir` points at (e.g. a
[jbbz-sandbox/sandbox-standards](https://github.com/jbbz-sandbox/sandbox-standards) checkout),
which `sandbox standards check` validates.

## Bundled MCP server (`werkmeister`)

The plugin's [`.mcp.json`](./.mcp.json) auto-wires the one werkmeister MCP server
(`werkmeister mcp`, source in [`apps/mcp`](../../apps/mcp)) exposing every tool —
workspace create/manage and lifecycle, PR review, issue lookups, k8s/kube health, and a
Claude session bridge — with **one form definition and graceful UI degradation per client**:

| Surface | How it connects | UI |
|---------|-----------------|----|
| **Claude Desktop** | `claude_desktop_config.json` (Desktop doesn't install plugins) | Inline MCP App (`ui://`): create form + workspace dashboard |
| **Cowork** | `install-workspace-dashboard` skill | Live artifact dashboard |
| **Claude Code CLI / VS Code** | this plugin's `.mcp.json` | Localhost browser: dashboard (`open-workspaces-ui`) + blocking create form |

The server detects whether the client renders MCP App UI (`io.modelcontextprotocol/ui`
capability); every tool also returns markdown/text, so any host degrades gracefully.
Call the create tool directly: `mcp__plugin_werkmeister_werkmeister__create-workspace-form` (optionally
`{ "issue": "<issue ID>" }`). Full tool table in the
[server README](../../apps/mcp/README.md).

### Register on Claude Desktop
Plugins don't install in Desktop, so add the same server to
`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{ "mcpServers": { "werkmeister": { "command": "werkmeister", "args": ["mcp"] } } }
```

## Dependencies

- **UI build (checkout only):** run `cd apps/sandbox-dashboard && pnpm run build` once — it
  builds the `ui://` HTML, the browser form and the localhost dashboard that `werkmeister mcp`
  serves. Without it the server still runs; its App tools fall back to text.
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
| plugin MCP server `sandbox-workspace` (`mcp__plugin_sandbox-tools_sandbox-workspace__*`) | `werkmeister` (`mcp__plugin_werkmeister_werkmeister__*`; it was `workspaces` until SW-48) |
| Claude Desktop entry `"sandbox-workspace"` (`mcp__sandbox-workspace__*`) | `"werkmeister"` (`mcp__werkmeister__*`; it was `"workspaces"` until SW-48) |
| registry MCP server `sandbox`, tools `sandbox-up`, `sandbox-status`, `sandbox-workspace`, … | `werkmeister`, tools `up`, `status`, `create-workspace`, … (every `sandbox-` prefix dropped; SW-48 then folded the `workspaces` server in) |

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
  `werkmeister`, as in [Register on Claude Desktop](#register-on-claude-desktop).
- Anything of yours that names the old tools or skills (permission rules in your own settings,
  prompts that say `/sandbox-diagnose`).

**Compatibility for one release:** the generated workspace permission rules allow both the old
and the new `mcp__plugin_…` prefixes, so a machine that has not run `w9r setup` yet keeps working. The
old `sandbox` entry in a workspace's `.mcp.json` is dropped at the next `init-workspace`.
