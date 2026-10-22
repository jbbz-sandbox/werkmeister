# workspaces dashboard

The localhost **workspaces dashboard** (`werkmeister dashboard`, and the server
`werkmeister connect` keeps on :3001), the `--browser-form` create page, and the
MCP App UI bundles. It has no MCP server: every tool lives in
[`apps/mcp`](../mcp) (`werkmeister mcp`), and this app's `/api/tool` calls that
server's `createServer()` over an in-memory transport.

## UI degradation ladder

Every host gets the richest surface it can render. Capability detection is
`rendersUi()` (`apps/mcp/src/workspace_tools.ts`): the `io.modelcontextprotocol/ui`
capability at initialize. Every tool **always** returns `structuredContent` + text, so the
model's view is tier-independent.

| Tier | Host | Surface |
|------|------|---------|
| 1 | Claude Desktop | Inline MCP App (`ui://`): `mcp-app.html` (create form), `mcp-list.html` (workspace dashboard), built and served by `apps/mcp` |
| 2 | Cowork | Live artifact `dist/workspace-list.artifact.html` — manual install via the `install-workspace-dashboard` skill; MCP prefix is read from its own meta block (source: `src/artifact-meta.json`) |
| 3 | Claude Code CLI / VS Code | Localhost browser: `open-workspaces-ui` opens `dist/browser.html` (Workspaces / New workspace / Open PRs tabs); `create-workspace-form` falls back to `dist/form.html` (blocking create form, `src/form-cli.ts`) |
| 4 | Anything else | Markdown/text from the same tools |

All UI bundles are single-file (`viteSingleFile`) and fully
self-contained — no CDN fetches. One neutral look everywhere: the list UI
(`werkmeister-ui/workspace-ui`) and the create form (`werkmeister-ui/create-form`),
both in `packages/sandbox-ui`, are each a
single implementation shared across tiers 1–3 — only the `HostBridge`
transport differs per entrypoint (`mcp-app`/`mcp-list` via ext-apps,
`artifact-main` via the Cowork bridge, `browser-main`/`form-main` via fetch).

Deliberately unused: MCP elicitation (Claude Code/Desktop don't render it) and
sampling (no host implements it) — prompt refinement goes through the
`refine-prompt` tool → local `claude` CLI.

## Tools

The tool table is in [`apps/mcp/README.md`](../mcp/README.md#tools).

Issue reads and status lookups go through the issue tracker `werkmeister setup`
configured (`issueTracker()` in `werkmeister-core/issue_tracker`); the dashboard never
names a tracker, and the create form's "Fetch from …" button takes its label from
the bundle (`ui:options.trackerLabel` on `issue_id`).

## Single source of truth

The CLI owns the inputs and the create logic:

- **Form fields** come from `getFormSchema` in werkmeister-core — a render-ready
  RJSF bundle (`{schema, uiSchema, formData, title}`) built from the same prompt
  definitions as the terminal wizard (`packages/sandbox-core/src/workspace_prompts.ts`,
  converted by `form_schema.ts`). Change a prompt there and every form tracks it.
- **Creation** runs `werkmeister workspace <feature> [--flag value …]`; form keys
  map 1:1 onto CLI flags. The CLI validates, refuses existing branches, and
  rolls back partial worktrees.

## Layout

| File | Role |
|------|------|
| `src/main.ts` | The localhost dashboard: `GET /` and `/api/*` on `PORT` (default 3001) |
| `src/form-cli.ts` | `werkmeister workspace --browser-form` — the no-MCP standalone form path |
| `src/lib/browser-ui.ts` | Localhost dashboard server (`/api/tool` dispatch via in-memory MCP client, SSE session stream) |
| `src/lib/localhost-form.ts` | Blocking localhost create-form server (localhost-callback pattern) |
| `src/lib/session-stream.ts` | Claude session tailer behind `claude-transcript`/SSE |
| `werkmeister-ui` (`packages/sandbox-ui`) | The shared UI modules (workspace list, create form, chat panel, theme, usage widget, markdown) and the display model |
| `werkmeister-core` (`packages/sandbox-core`) | Bridge to `sandbox` / `gh` / `kubectl` / `claude` CLIs, the issue-tracker strategies, and the `./cache` subpath — imported as a workspace dependency, not a local `lib/` file |
| other `src/*.ts` + `*.html` | The three vite inputs: `workspace-list.artifact`, `browser`, `form` |

## Build & test

```bash
pnpm install                     # at the repo root (pnpm workspaces)
cd apps/sandbox-dashboard
pnpm run build                   # typecheck + 3 UI bundles + dashboard server → dist/
node test/localhost-form.smoke.mjs  # and the other test/*.smoke.mjs
```

Most `test/*.smoke.mjs` exercise `werkmeister-core`, so
`packages/sandbox-core` must be built first (`pnpm run build` there, or at the
repo root) — they import the package by name, never by relative path.

## Wiring

The MCP wiring is `werkmeister mcp` (see `apps/mcp/README.md`). This app only
needs building: `werkmeister mcp` reads its `dist/` for the `ui://` HTML and the
browser form.

```bash
pnpm run serve:http         # the dashboard at http://localhost:3001/
```
