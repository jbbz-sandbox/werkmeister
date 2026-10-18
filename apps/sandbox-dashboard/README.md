# sandbox-workspace MCP server

The sandbox **workspace dashboard** (`sandbox dashboard`): ~29 tools for creating and
operating sandbox workspaces — worktree creation, container lifecycle, PR review,
issue lookups, k8s/kube health, and an embedded Claude Code session bridge — plus
interactive UIs for every kind of MCP host. It delegates all real work to the
`sandbox` CLI, `gh`, `kubectl`, and the local `claude` CLI; the server renders,
routes, and shells out.

## UI degradation ladder

Every host gets the richest surface it can render. Capability detection is
`hostRendersUi()` (server.ts): the `io.modelcontextprotocol/ui` capability at
initialize. Every tool **always** returns `structuredContent` + text, so the
model's view is tier-independent.

| Tier | Host | Surface |
|------|------|---------|
| 1 | Claude Desktop | Inline MCP App (`ui://`): `dist/mcp-app.html` (create form), `dist/mcp-list.html` (workspace dashboard) |
| 2 | Cowork | Live artifact `dist/workspace-list.artifact.html` — manual install via the `install-workspace-dashboard` skill; MCP prefix is read from its own meta block (source: `src/artifact-meta.json`) |
| 3 | Claude Code CLI / VS Code | Localhost browser: `open-workspaces-ui` serves `dist/browser.html` (Workspaces / New workspace / Open PRs tabs); the `workspace` tool auto-falls-back to `dist/form.html` (blocking create form, `src/lib/localhost-form.ts`) |
| 4 | Anything else | Markdown/text from the same tools |

All five UI bundles are single-file (`viteSingleFile`) and fully
self-contained — no CDN fetches. One neutral look everywhere: the list UI
(`src/workspace-ui.ts`) and the create form (`src/create-form.ts`) are each a
single implementation shared across tiers 1–3 — only the `HostBridge`
transport differs per entrypoint (`mcp-app`/`mcp-list` via ext-apps,
`artifact-main` via the Cowork bridge, `browser-main`/`form-main` via fetch).

Deliberately unused: MCP elicitation (Claude Code/Desktop don't render it) and
sampling (no host implements it) — prompt refinement goes through the
`refine-prompt` tool → local `claude` CLI.

## Tools

| Group | Tools |
|-------|-------|
| Create workspace | `workspace` (App tool: inline form or localhost fallback; `issue` arg pre-fills), `create-workspace`, `workspace-form-schema`, `issue-form-data`, `refine-prompt` |
| List & manage | `list-workspaces` (App tool), `workspace-status`, `workspace-action` (start/stop/restart/down), `close-out` (end a workspace: shipped, or `abandon` with a reason), `open-workspace` (VS Code), `open-feature` (tagged browser), `open-workspaces-ui` |
| Pull requests | `workspace-prs`, `open-prs`, `pr-approve`, `pr-reconcile` |
| Issues | `issue`, `issue-statuses` |
| Infra | `sandbox-connect`, `docker-ui`, `k8s-forwards-status`, `kube-context`, `kube-switch` |
| Claude sessions | `claude-transcript`, `claude-send`, `claude-turn-status`, `claude-resume` (Terminal) |

Issue reads and status lookups go through the issue tracker `sandbox setup`
configured (`issueTracker()` in `werkmeister-core/issue_tracker`); the dashboard never
names a tracker, and the create form's "Fetch from …" button takes its label from
the bundle (`ui:options.trackerLabel` on `issue_id`).

## Single source of truth

The CLI owns the inputs and the create logic:

- **Form fields** come from `getFormSchema` in werkmeister-core — a render-ready
  RJSF bundle (`{schema, uiSchema, formData, title}`) built from the same prompt
  definitions as the terminal wizard (`packages/sandbox-core/src/workspace_prompts.ts`,
  converted by `form_schema.ts`). Change a prompt there and every form tracks it.
- **Creation** runs `sandbox workspace <feature> [--flag value …]`; form keys
  map 1:1 onto CLI flags. The CLI validates, refuses existing branches, and
  rolls back partial worktrees.

## Layout

| File | Role |
|------|------|
| `src/server.ts` | All tool registrations + `ui://` resources + capability routing |
| `src/main.ts` | stdio (Desktop / plugin) and HTTP entry; HTTP mode also serves the dashboard |
| `src/form-cli.ts` | `sandbox workspace --browser-form` — the no-MCP standalone form path |
| `src/lib/browser-ui.ts` | Localhost dashboard server (`/api/tool` dispatch via in-memory MCP client, SSE session stream) |
| `src/lib/localhost-form.ts` | Blocking localhost create-form server (localhost-callback pattern) |
| `src/lib/session-stream.ts` | Claude session tailer behind `claude-transcript`/SSE |
| `src/lib/markdown.ts` · `src/lib/workspace-search.ts` | markdown-it config (`html:false`); workspace fuzzy match |
| `werkmeister-core` (`packages/`) | Bridge to `sandbox` / `gh` / `kubectl` / `claude` CLIs, the issue-tracker strategies, and the `./cache` subpath — imported as a workspace dependency, not a local `lib/` file |
| other `src/*.ts` + `*.html` | The five vite inputs: `mcp-app`, `mcp-list`, `workspace-list.artifact`, `browser`, `form` |

## Build & test

```bash
npm install                      # at the repo root (npm workspaces)
cd apps/sandbox-dashboard
npm run build                    # typecheck + 5 UI bundles + server → dist/
node test/localhost-form.smoke.mjs  # and the other test/*.smoke.mjs
```

All ten `test/*.smoke.mjs` pass. Seven of them exercise `werkmeister-core`, so
`packages/sandbox-core` must be built first (`npm run build` there, or at the
repo root) — they import the package by name, never by relative path.

## Wiring

- **Claude Code (CLI / VS Code):** installed automatically by the
  `sandbox-tools` plugin's `.mcp.json` (`sandbox dashboard`).
- **Claude Desktop** (plugins don't install there):

```json
{ "mcpServers": { "sandbox-workspace": { "command": "sandbox", "args": ["dashboard"] } } }
```

Fully quit and reopen Desktop after changes; rebuild first. The server finds the
`sandbox` wrapper via `$SANDBOX_BIN`, then `$SANDBOX_ROOT/sandbox`, then by
walking up from the app directory, then `~/.local/bin/sandbox`, and augments
`PATH` (Homebrew, `~/.local/bin`, `~/.cargo/bin`) because Desktop launches
servers with a minimal environment. `SANDBOX_ROOT` outranks the last two because
it names the checkout you are actually running, which the walk-up and the global
symlink both get wrong from a feature worktree.

### Local testing without a host

```bash
npm run serve:http          # http://localhost:3001/mcp + the dashboard at /
```
