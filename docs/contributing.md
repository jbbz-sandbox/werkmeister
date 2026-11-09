# Contributing

How to build Werkmeister from source, work on its Claude Code plugin, and run the checks CI runs. To use Werkmeister, start at the [Quick Start](quick-start.md) instead.

## Build from source

```bash
git clone https://github.com/jbbz-sandbox/werkmeister.git
cd werkmeister

# pnpm via corepack, at the version package.json pins
corepack enable
pnpm install
pnpm turbo run build --filter=werkmeister

# apps/cli/werkmeister resolves a node runtime (WERKMEISTER_NODE -> PATH -> newest nvm)
# and execs apps/cli/dist/main.js.
apps/cli/werkmeister --help
```

After the first build, `apps/cli/werkmeister` is self-contained. Rebuild (`pnpm turbo run build --filter=werkmeister`) after pulling changes to `apps/cli/src/`.

Docs pages name commands, flags, paths and MCP tools the code must still have; `pnpm run docs:check` fails when one drifts, and `pnpm run docs:gen` rewrites the generated regions. See [docs-sync.md](docs-sync.md).

## The Claude Code plugin from a checkout

The plugin lives in [`plugins/werkmeister`](../plugins/werkmeister). To load it from a checkout instead of the marketplace, either add the checkout as a marketplace:

```
/plugin marketplace add /path/to/werkmeister
/plugin install werkmeister@werkmeister
```

or set `CLAUDE_CODE_PLUGIN_DIRS` to `plugins/werkmeister` in the `env` block of `~/.claude/settings.json`. `plugins/werkmeister/skills/install-check/check.sh --fix` keeps that link healthy.

**UI build.** Run `cd apps/werkmeister-dashboard && pnpm run build` once. It builds the `ui://` HTML, the browser form and the localhost dashboard that `werkmeister internal mcp` serves. Without it the server still runs, and its App tools fall back to text. The workspace form, with its "Refine with Claude" and issue fetch, lives in [`apps/werkmeister-dashboard`](../apps/werkmeister-dashboard); refine uses the local `claude` CLI.

### Checks

Validate changes before committing:

```
claude plugin validate ./plugins/werkmeister
claude plugin validate .   # validates the marketplace manifest
```

The full check, from the repo root after `corepack pnpm install` (or `pnpm check` inside `plugins/werkmeister`):

```
pnpm --filter werkmeister-plugin check
```

It regenerates the gitignored `.claude-plugin/types/` that `tsc` reads, then runs `tsc -p . --noEmit`, `claude plugin validate .` and `claude plugin test .`. The types are Claude Code's, so `plugins/werkmeister/scripts/gen-types.mjs` has the `claude` on your PATH write them, by loading the folder as a plugin under a throwaway HOME with no login: no API call, and the types always match your installed Claude Code. CI runs the same `typecheck` and `test` scripts through turbo, against the Claude Code version pinned in `.github/workflows/ci.yml`.

### How the mods work

All three mods are registered in [`plugins/werkmeister/hooks/register.tsx`](../plugins/werkmeister/hooks/register.tsx).

- **Install check.** On every interactive session start it runs `skills/install-check/check.sh --fix` (`runInstallCheck`). It is silent when the install is clean or there is no checkout, and logs drift to the transcript. After a repair it toasts a restart notice and refuses the next *typed* prompt once, because the session already loaded the old MCP server and skills. Messages from other sessions, background notifications, slash commands and headless sessions are never refused. `werkmeister machine setup` removes the hand-copied `~/.claude` hooks this replaced.
- **Workspace band.** It shares the card's lines with the pane (`cardInfo`) and polls on its own timers, slower than the pane (rows 15 s, PRs 5 min, resources 60 s), since every workspace session runs one. Outside a workspace it draws nothing and reads nothing.
- **`/workspaces` pane.** Cards are drawn from the shared display model: `hooks/display-model.ts` is a copy of `packages/werkmeister-ui`'s, and `packages/werkmeister-ui/test/pane-copy.test.mjs` keeps the two in step. The layout follows [ui-spec.md](ui-spec.md) and `docs/design/workspace-card/design/Pane View.dc.html`.
  - Up, Stop, Pause, Resume, Restart and Down run werkmeister-core in a `node` child: the desktop's auto mode refuses a plugin's call to its own MCP server, but not a host process.
  - Close out and Abandon archive every desktop session whose cwd is in the workspace (`ccd_session_mgmt` `archive_session`; a refused one is reported as left open). The same archive runs after a successful `close-out` MCP tool call through a `tool.call` hook, since that server can't reach the app's session tools.
  - ＋ New session opens `claude://code/new?folder=…`, the link the app's Finder service uses. ⇆ Open beside splits only sessions this one started; for any other it opens the session's own link and toasts how to split it from the sidebar. 📌 Pin uses `ccd_sidebar` `set_pinned`, and a session that starts inside a workspace files itself under a `Feature Workspaces` sidebar group, when one exists and the session is in no group (`ccd_sidebar` `move_sessions`).
  - Probe findings (2026-10-09): `change_directory` from a plugin call works after the person approves the folder. A `claude://` link in a pane does not focus the session, since the desktop pane draws nothing for it. The fallback is a Jump button that calls `ccd_window` `open_session_in`, which only focuses sessions this one started; otherwise it toasts the title to open from the sidebar.

### Code standards (`w9r-*`) are not in the plugin

The `w9r-implement` / `w9r-research` entry skills and the `w9r-*-standard` code standards are projected into each workspace's `.claude/skills/` by `werkmeister workspace init`. Entry-skill sources live in [`apps/cli/infra/skills/`](../apps/cli/infra/skills), and the standards are rendered at the same step from the tree `overrides.standards_dir` points at (e.g. a [jbbz-sandbox/sandbox-standards](https://github.com/jbbz-sandbox/sandbox-standards) checkout), which `werkmeister standards check` validates. <!-- name-check: ignore -->
