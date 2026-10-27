---
name: workspace
description: "Create a brand-new workspace (git worktrees on a <user>/<workspace> branch + init). Use when the user says '/werkmeister:workspace', 'create a workspace', 'new workspace', 'spin up a workspace', 'make a workspace for <TICKET-ID>', or any request to create/bootstrap a new workspace from scratch."
---

# Werkmeister Workspace

> Paths: `~/.werkmeister/` and a workspace's `.werkmeister/` are the current names. A machine or workspace set up before the rename moves its old directories with `werkmeister migrate`.

**Every create goes through `createWorkspace`** (packages/werkmeister-core/src/sandbox.ts) — the CLI,
the browser form, the MCP server and the /workspaces pane all call it. Never write
workspace files by hand.

With an `issue_id`, `createWorkspace` always:
1. fetches the issue and stores it verbatim in `.werkmeister/issue.md` — it **fails the create**
   if the issue can't be read (run `werkmeister connect` to check tracker sign-in);
2. fills `task` from the issue title when empty;
3. has a model rewrite the issue into `description` / `starting_prompt` for whichever is
   empty (`--no-distill` skips it; a failed rewrite only warns);
4. renders the issue section (link, copy date, `werkmeister issue view`) in CLAUDE.md and the
   brief, for both JIT and ICM.

The create leaves the issue's status alone (a workspace can be created and parked). From
there it moves by itself, forward only: To Do → In Progress when the first stage or phase
runs `werkmeister issue start` → In Review at `werkmeister pr open` → Done at ship
(docs/workspace-lifecycle.md § Issue status; `overrides.issue_statuses` renames each status).

## Pick the path

| Situation | Do |
|---|---|
| every input known (feature, issue, repos) | `werkmeister workspace <feature> --issue-id <ref> --repos <r1,r2> [--services <a,b>] [--work-type <t>] [--context-strategy icm] [--autonomous] [--model <alias|id>]`. Pass `--task` only to override the issue title. Leave `--services` out unless the ticket names services to run (see **Services** below) |
| the person should review the fields first | the /workspaces pane's Create tab, or the browser form (below) |
| many issues at once | one `werkmeister workspace` call per issue, **in sequence** (they share source repos), then run the batch check. Before the first: the `werkmeister` CLI runs from the werkmeister repo's `apps/cli/dist`, so check that checkout is on an up-to-date `main` and rebuilt (`pnpm run build` at its root), or the batch comes out with stale defaults |
| many issues, run unattended | as above with `--autonomous` on each create, plus `--model sonnet` (or `haiku`) when the job is mechanical (lint passes, renames, timeout bumps). Then start one Claude Code session per workspace folder with the prompt `start the run`, **one at a time**: each new folder raises a trust prompt, and parallel starts collide. Start each session on the workspace's `model` when it has one (`list-workspaces` returns it) |

**Services** (none by default): list only the services the ticket says to run locally, e.g. a web app it changes and someone will click through. Never list every service "so the gate has containers". `werkmeister pr gate` starts one container for each touched repo that has none running, and stops it afterwards (SW-34). Each listed service is a container that `werkmeister up` starts.

**`autonomous`** (off by default; `--autonomous`, `WERKMEISTER_AUTONOMOUS=1`, `autonomous: true` in `workspace.yml`, or the form's checkbox): an icm workspace runs stage 01 → `werkmeister pr open` with self-checks instead of human checks, and `.claude/settings.json` allows the git/werkmeister/docker/gh/node/python3 calls a headless `claude-send "start the run"` needs. Set it only when the person asked for an unattended run — they then review only the PR. Off again: `autonomous: false`, then `werkmeister init-workspace`.

**`model`** (blank by default = Claude Code's default; `--model <alias|id>`, `WERKMEISTER_MODEL`, `model:` in `workspace.yml`, or the form's field): an alias (`opus`, `sonnet`, `haiku`) or a full `claude-…` id. Written to the workspace's `.claude/settings.json`, passed as `--model` by `claude-send` / `claude-resume`, and returned by `list-workspaces` / `status`. A `model` the person set in `settings.json` by hand is never overwritten. Clear it: delete `model:` from `workspace.yml`, then `werkmeister init-workspace`.

**`auto_stop`** (off by default; `--auto-stop`, `WERKMEISTER_AUTO_STOP=1`, `auto_stop: true` in `workspace.yml`, or the form's checkbox): writes a SessionEnd hook to the workspace's `.claude/settings.json` that runs `werkmeister stop --if-idle`. When a session in the workspace ends (not `/clear` or `/resume`, not a headless `claude -p` turn) and no other Claude session is open there, the feature's containers stop; the slot and volumes stay, so `werkmeister up` resumes fast. Shared infra is never stopped. Off again: `auto_stop: false`, then `werkmeister init-workspace` (or `werkmeister up`) removes the hook.

**Batch check** — after creating, for each new workspace:

```bash
test -f <ws>/.werkmeister/issue.md && grep -q '^## Issue$' <ws>/CLAUDE.md && echo ok
```

Report any workspace that fails it; don't hand-patch files.

The workspace is git worktrees (one per repo, derived from the selected **services**) on a
`<user>/<workspace>` branch under `$WERKMEISTER_WORKSPACES_ROOT`, followed by `init-workspace`
(writes `CLAUDE.md`, `.env`, `compose.yml`, …).

There is **no hand-maintained schema** — fields are built from the same prompt
definitions (`_WIZARD_PROMPTS` in `packages/werkmeister-core/src/workspace_prompts.ts`) that
drive the terminal wizard. So every
surface shows the same fields, labels, defaults, and validation — and the **same look**:
every surface (browser form, dashboard tab, Desktop inline) renders the one shared form
component (`packages/werkmeister-ui/src/create-form.ts`).

## Which browser shows the form

| Where this session runs | How to open the form |
|-------------------------|----------------------|
| **Claude Code desktop app** (the system prompt says so, and the `mcp__Claude_Browser__*` tools are present) | In the app's own Browser pane: see *Claude Code desktop* below. |
| **VS Code extension**, a **terminal**, or anywhere else | In the system browser: the foreground `--browser-form` command below. Do this even if some browser tool happens to be available. |

## Preferred path — `werkmeister workspace --browser-form`

This is the self-contained path; it works in **Claude Code / VS Code** without any
MCP-server connection. It opens the form on localhost in the **system browser** (the same
form, styling, and create path the Desktop MCP App uses), blocks until submit/cancel,
creates the workspace, and prints a single outcome JSON to **stdout** (progress → stderr).

```bash
werkmeister workspace --browser-form                      # open the form; create on submit
werkmeister workspace --browser-form --issue-id <ref>      # pre-fill from an issue
werkmeister workspace --browser-form --open               # also launch VS Code afterward
```

Every flag given alongside `--browser-form` pre-fills the form.

Run it in the **foreground** with a generous Bash timeout (~900000 ms) — it blocks while the
user fills the form (default 600s wait) plus worktree creation + init.

Outcome JSON shapes:

| Shape | Action |
|-------|--------|
| `{"status":"submitted","create":{"ok":true,"result":{…}}}` | Success — `result.workspacePath` is the new dir. |
| `{"status":"submitted","create":{"ok":false,"error":"…"}}` | Create failed — show `error`, offer to fix + retry. |
| `{"status":"cancelled"}` / `{"status":"timeout"}` | Nothing created — offer to re-run. |
| `{"status":"error","message":"…"}` | Pre-form failure (e.g. app not built) — relay it. |

### Claude Code desktop — open the form in the in-app browser

Only in the **Claude Code desktop app**: show the form in the Browser pane beside the
conversation instead of the system browser. Only a tool call the model makes may drive that
pane, so do it in these steps yourself:

1. Start the CLI in the **background** with the browser launch suppressed, stderr to a file:

   ```bash
   WERKMEISTER_FORM_NO_BROWSER=1 werkmeister workspace --browser-form 2>/tmp/workspace-form.err >/tmp/workspace-form.out
   ```

2. Read the form URL from the stderr file (the line `[workspaces] workspace form: http://127.0.0.1:<port>/`).
3. Call `mcp__Claude_Browser__preview_start` with `url` set to that URL. The form loads in
   the browser tab, but no browser tool brings the pane into view: check
   `mcp__Claude_Browser__tabs_context`, and when it says the pane is hidden, tell the user to
   open the Browser pane to see the form. Close any tab left from an earlier form run.
4. Wait for the background command to exit (it blocks until submit, cancel, or timeout), then
   read the outcome JSON from the stdout file and act on it per the table above.

Add `--issue-id`/`--open` to step 1 exactly as for the foreground form.

### Desktop inline alternative — the `create-workspace-form` MCP tool

In **Claude Desktop**, the bundled `werkmeister` MCP server renders the form **inline**
(an MCP App `ui://` resource). Calling `mcp__plugin_werkmeister_werkmeister__create-workspace-form` there shows the
same form in-conversation; on a CLI/VS-Code client it falls back to the same browser
form as `--browser-form`. Use `--browser-form` from Claude Code; reserve the MCP tool for
Desktop.

### Prerequisites
- The `werkmeister` CLI on `PATH` (e.g. `~/.local/bin/werkmeister`) and `node`.
- The app built once: `cd apps/werkmeister-dashboard && pnpm run build` (produces `dist/form-cli.js`
  for `--browser-form` and `dist/main.js` for `werkmeister dashboard`). Without the build, `--browser-form` errors with a clear message.
  The form page (`dist/form.html`) is fully self-contained — no internet needed.

## Common pitfalls

- **Issue can't be read.** The create fails before anything is made; run `werkmeister connect`, fix sign-in, retry.
- **No repos resolvable.** Worktree repos come from `--repos` plus the repos owning the
  selected **services**; with neither, `werkmeister workspace` has nothing to make worktrees from
  and exits nonzero. Pass `--repos r1,r2` (the form's "Additional repos" field).
- **Source repo missing.** Worktrees are cut from `$WERKMEISTER_REPOS_ROOT/<repo>`; a missing
  checkout fails the create.
- **Workspace already exists.** `werkmeister workspace` skips worktree creation and just re-runs
  `init-workspace` (idempotent) — not an error.
- **After creation:** tell the user to `cd <workspace-path>` and open a Claude Code session
  there; the next step is `werkmeister up <feature>` from inside the workspace — do not run
  `werkmeister up` yourself.
