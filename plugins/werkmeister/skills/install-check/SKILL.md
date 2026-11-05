---
name: install-check
description: Use when checking or fixing whether the global werkmeister CLI (or w9r), its MCP server or the werkmeister Claude Code plugin runs from the ~/repos/werkmeister checkout - "is the global werkmeister from the repo", "werkmeister drift", werkmeister MCP tools acting like an old version, after `npm i -g werkmeister` or `npx werkmeister setup`, or a repo change that doesn't show up in the CLI; and after a PR merges or a release publishes, to bring the dev link up to main ("upgrade the global werkmeister", "pull and rebuild"), or to merge a PR through the merge queue.
---

# Werkmeister install check

The global `werkmeister`/`w9r` CLI, the plugin's MCP server (which runs `werkmeister` from PATH) and the Claude Code plugin should all come from the repo checkout (`$WERKMEISTER_REPO`, defaulting to `~/repos/werkmeister`). Anything else is drift.

## Run

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/install-check/check.sh"         # report only, exits 1 on drift
bash "${CLAUDE_PLUGIN_ROOT}/skills/install-check/check.sh" --fix   # repair, then run it again to confirm
bash "${CLAUDE_PLUGIN_ROOT}/skills/install-check/check.sh" --pull  # fast-forward main first, then --fix and build every package
```

Run the check first and show the person its output. If it finds drift, run `--fix`, then run the check again, and report the final `RESULT` line.

## What it checks and fixes

| Check | `--fix` does |
|---|---|
| `werkmeister`, `w9r` on PATH resolve into `apps/cli` | `npm rm -g werkmeister && npm link` in `apps/cli` |
| `dist/main.js` is newer than `apps/cli/src` and `packages/*/src` | `corepack pnpm install --frozen-lockfile && corepack pnpm turbo run build --filter=werkmeister` (turbo builds core first); prints `FIX` only when it succeeds, `ERROR` otherwise |
| `~/.werkmeister/env.sh` `WERKMEISTER_ROOT` is `apps/cli` | reports only: fix `werkmeister_root` in `~/.werkmeister/config.yaml`, then run `werkmeister machine config --write` |
| `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` includes `plugins/werkmeister` | adds it, and sets `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` |
| No marketplace `werkmeister@…` plugin installed | reports only: `claude plugin uninstall werkmeister` (ask the person first) |
| Plugin `.mcp.json` runs `werkmeister` from PATH | reports only |
| No file in `packages/werkmeister-vscode/src` is newer than the installed `~/.vscode/extensions/jbbz.werkmeister-vscode-*` | reports only: `pnpm --filter werkmeister-vscode install:local` (ask the person first) |

`--pull` refuses (exit 2, nothing pulled or built) when the checkout isn't on `main`, has uncommitted changes, or can't fast-forward. Its `PULL` line names the commit it moved from, for rollback.

On a machine without the checkout (`$WERKMEISTER_REPO/apps/cli` missing) the script exits 2: there is nothing to compare against.

## After a fix

- An MCP server that is already running keeps the old binary. Tell the person to reconnect it with `/mcp` or restart Claude Code.
- A settings.json change takes effect in the next session.
- `npm i -g werkmeister` and `npx werkmeister setup` overwrite the link. Avoid them on this machine.

## After a merge or a release

The dev link is current when it is built from an up-to-date `main`; this machine doesn't install the npm release (that would overwrite the link).

1. A PR merged: `check.sh --pull`. It pulls, installs, runs the full `turbo run build`, and prints `PULL  main <old> -> <new>`. Note `<old>` for rollback.
2. A release: the Changesets version PR merged and npm shows the version (`npm view werkmeister version`). Then `check.sh --pull`, as above; the pull brings the version commit.
3. `werkmeister --version` prints no stale-build warning. Running MCP servers keep the old build: `/mcp` to reconnect them.

## Merging through the merge queue

`main` merges through a merge queue and auto-merge is off, so `gh pr merge` fails, `--auto` included. Use:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/install-check/queue-pr.sh" <pr> [owner/repo]
```

It waits for the PR's checks (a bot-pushed branch lists none at first; that isn't a failure), refuses a PR whose checks failed or whose head moved meanwhile, queues it with the GraphQL `enqueuePullRequest`, and waits for `MERGED`. Exit 1 says why it stopped. It merges: run it only when the person asked for that PR to merge.

- One at a time, in order. A merge to `main` force-pushes the Changesets version PR, and a push drops a PR from the queue. Queue the version PR last, after the others have merged.
- Run it in the background; a queue run takes minutes.

## Session start hook

The plugin's hooks module (`hooks/register.tsx`, `runInstallCheck`) runs `check.sh --fix` when an interactive session starts. Clean, or no checkout: silent. Drift: the output goes to the transcript as a dim line. MCP servers and plugin skills load before the hook runs, so a repair cannot reach the session it ran in: when a `FIX` was applied the hook shows a restart toast and refuses the person's next typed prompt, once, with the same message (restart Claude Code, or run `/mcp` and `/reload-plugins`). A message from another session, a background notification or a slash command is never refused: a refused relay is dropped for good and its sender never learns (SW-348). A headless session (`claude -p`) is never refused either, since nobody can restart it.
