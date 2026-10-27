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

### Mods

| Mod | What it does |
|-----|--------------|
| `/workspaces` | Opens by itself when an interactive session starts in a folder of workspaces (one whose child holds `.werkmeister/workspace.yml` or the older `.sandbox/workspace.yml`, e.g. `~/features`). A docked pane with one compact card per workspace (docs/ui-spec.md, `docs/design/workspace-card/design/Pane View.dc.html`), drawn from the shared display model (`hooks/display-model.ts`, a copy of `packages/werkmeister-ui`'s that `packages/werkmeister-ui/test/pane-copy.test.mjs` keeps in step). Line 1: the name, the agent chip (`◌ Working` · `● Needs you` · `✓ Done` · `Idle`, from SW-46's agent state), and `⚙ Auto` for an autonomous run. Line 2: work type · task from workspace.yml. Line 3, always in this order: `containers 2 of 3 up · PRs repo#12 Open · CI running · stage 4/5 implement`. The last part is the Workflow: the ICM stage, the JIT phase, or the lifecycle step (`Ready to close out`, `Awaiting release`; docs/workspace-lifecycle.md). A Needs you card quotes the question it asked, and is the only card with an amber border. `?` beside the tabs shows the legend. Below these sit the buttons in three labelled rows by what they act on (ui-spec § Actions, SW-105): `session` (⇆ Open beside or Continue, ＋ New session, 📌 Pin), `containers` (▶ Resume or ▶ Up, ■ Stop, ⏸ Pause, ↻ Restart, ⏻ Down, then Logs and Open feature ↗ while they run) and `work` (↻ Refresh PRs, Open issue ↗, ✓ Close out, ✕ Abandon…). Buttons that don't apply are hidden; the primary action by state (▶ Resume while paused, Continue, ✓ Close out once shipped, or ▶ Up while nothing runs) is highlighted where it sits. Logs opens a Terminal window following the containers' logs (`werkmeister logs`); Open feature ↗ opens the feature in the browser with its routing cookie. Up / Stop / Pause / Resume / Restart / Down run werkmeister-core in a `node` child (a plugin's call to its own MCP server is refused by the desktop's auto mode; a host process is not). ↻ Refresh PRs runs `sandbox pr status` and re-polls the PRs; it is also the retry when a card says `PRs unavailable`. The end verb is `sandbox close-out` (docs/workspace-lifecycle.md): ✓ Close out once every PR shipped, and ✕ Abandon…, which asks for the reason in the pane. Each confirms inline in the card before it runs, then archive every desktop session whose cwd is in the workspace (`ccd_session_mgmt` `archive_session`; a refused one is reported as left open) and list terminal sessions still open there to `/exit`. The same archive runs after a successful `close-out` MCP tool call, through a `tool.call` hook, since that server can't reach the app's session tools. ＋ New session opens a new Claude Code Desktop session in the workspace folder (`claude://code/new?folder=…`, the link the app's Finder service uses). ⇆ Open beside / ↗ Continue in VS Code / Terminal picks up the newest session where it lives: ⇆ Open beside opens the Desktop session in split view beside this chat so the pane stays in sight (the app splits only sessions this one started; for any other it opens the session's own link, which takes this chat's place, and toasts how to split it from the sidebar), Continue in VS Code opens the folder in VS Code for a VS Code session, else Continue in Terminal resumes it in a Terminal window. 📌 Pin / Unpin pins or unpins that session in the app's sidebar (`ccd_sidebar` `set_pinned`; desktop only). A Workspaces \| ＋ Create tab bar heads the pane; on the Workspaces tab, ☐ Focused only shows only workspaces whose `.werkmeister/workspace.yml` `labels` include `focus`, and the choice survives a plugin reload. The Create tab draws the workspace form from the same schema as the browser form (fields, grouped checkbox columns, a multi-line starting prompt with Refine with Claude) with a button that fills empty fields from the issue, and creates the workspace directly. A desktop session that starts inside a workspace files itself under the sidebar group named `Feature Workspaces`, if that group exists and the session is in no group yet (`ccd_sidebar` `move_sessions`). The `workspace_form` tool lets Claude fill the form from the prompt box (where pasting works); it never creates the workspace. Source: [`hooks/register.tsx`](hooks/register.tsx). |

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
(`werkmeister mcp`, source in [`apps/werkmeister-mcp`](../../apps/werkmeister-mcp)) exposing every tool —
workspace create/manage and lifecycle, PR review, issue lookups, k8s/kube health, and a
Claude session bridge — with **one form definition and graceful UI degradation per client**:

| Surface | How it connects | UI |
|---------|-----------------|----|
| **Claude Desktop** | `claude_desktop_config.json` (Desktop doesn't install plugins) | Inline MCP App (`ui://`): create form + workspace dashboard |
| **Claude Code CLI / VS Code** | this plugin's `.mcp.json` | Localhost browser: dashboard (`open-workspaces-ui`) + blocking create form |

The server detects whether the client renders MCP App UI (`io.modelcontextprotocol/ui`
capability); every tool also returns markdown/text, so any host degrades gracefully.
Call the create tool directly: `mcp__plugin_werkmeister_werkmeister__create-workspace-form` (optionally
`{ "issue": "<issue ID>" }`). Full tool table in the
[server README](../../apps/werkmeister-mcp/README.md).

### Register on Claude Desktop
Plugins don't install in Desktop, so add the same server to
`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{ "mcpServers": { "werkmeister": { "command": "werkmeister", "args": ["mcp"] } } }
```

## Dependencies

- **UI build (checkout only):** run `cd apps/werkmeister-dashboard && pnpm run build` once — it
  builds the `ui://` HTML, the browser form and the localhost dashboard that `werkmeister mcp`
  serves. Without it the server still runs; its App tools fall back to text.
- The `w9r` CLI (package `werkmeister` 0.14 or later) must be on `PATH`, and Docker running.
- **Self-contained:** the workspace form and its "Refine with Claude" / issue-fetch logic
  live in [`apps/werkmeister-dashboard`](../../apps/werkmeister-dashboard) — no external skill is required.
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

The full check, from `plugins/werkmeister`:

```
claude plugin validate . && claude plugin test . && npx -p typescript tsc -p . --noEmit
```

`tsc` reads its types from `.claude-plugin/types/`, which is gitignored: Claude Code writes it
beside the plugin the first time a session loads the folder as a plugin (`claude --plugin-dir
plugins/werkmeister`, or a hot-reloaded dev mod). A fresh worktree has none, so `tsc` reports
`Cannot read file '.claude-plugin/types/tsconfig.json'`. The types are Claude Code's, not this
repo's, so they are not committed. Until a session has loaded the folder, point `tsc` at the
`claude-code.d.ts` the `plugin-authoring` skill writes (its path is printed when the skill loads)
with a throwaway tsconfig kept outside the repo:

```json
{ "compilerOptions": { "target": "es2023", "lib": ["es2023"], "types": [], "module": "esnext",
    "moduleResolution": "bundler", "strict": true, "noUncheckedIndexedAccess": true, "noEmit": true,
    "skipLibCheck": true, "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment" },
  "include": ["<path to claude-code.d.ts>", "<repo>/plugins/werkmeister/hooks", "<repo>/plugins/werkmeister/types"] }
```

then `npx -p typescript tsc -p <that tsconfig>`. TypeScript is not a dependency here, so a bare
`npx tsc` fails with "This is not the tsc command you are looking for".

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

**Checkout installs** that set `CLAUDE_CODE_PLUGIN_DIRS` to `.../plugins/sandbox-tools` stop
loading the plugin: the plugins/sandbox-tools link was removed (SW-23). Point it at
`.../plugins/werkmeister`, and rename the `sandbox` entry in `extraKnownMarketplaces` to
`werkmeister` (or delete it).

**Also update by hand:**
- Claude Desktop: in `claude_desktop_config.json`, rename the `sandbox-workspace` server to
  `werkmeister`, as in [Register on Claude Desktop](#register-on-claude-desktop).
- Anything of yours that names the old tools or skills (permission rules in your own settings,
  prompts that say `/sandbox-diagnose`).

**Compatibility for one release:** the generated workspace permission rules allow both the old
and the new `mcp__plugin_…` prefixes, so a machine that has not run `w9r setup` yet keeps working. The
old `sandbox` entry in a workspace's `.mcp.json` is dropped at the next `init-workspace`.
