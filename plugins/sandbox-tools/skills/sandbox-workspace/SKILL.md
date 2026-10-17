---
name: sandbox-workspace
description: "Create a brand-new sandbox workspace (git worktrees on a <user>/<workspace> branch + init). Use when the user says '/sandbox-workspace', 'create a workspace', 'new sandbox workspace', 'spin up a workspace', 'make a workspace for <TICKET-ID>', or any request to create/bootstrap a new sandbox workspace from scratch."
---

# Sandbox Workspace

**Every create goes through `createWorkspace`** (packages/sandbox-core/src/sandbox.ts) — the CLI,
the browser form, both MCP servers and the /workspaces pane all call it. Never write
workspace files by hand.

With an `issue_id`, `createWorkspace` always:
1. fetches the issue and stores it verbatim in `.sandbox/issue.md` — it **fails the create**
   if the issue can't be read (run `sandbox connect` to check tracker sign-in);
2. fills `task` from the issue title when empty;
3. has a model rewrite the issue into `description` / `starting_prompt` for whichever is
   empty (`--no-distill` skips it; a failed rewrite only warns);
4. renders the issue section (link, copy date, `sandbox issue view`) in CLAUDE.md and the
   brief, for both JIT and ICM.

## Pick the path

| Situation | Do |
|---|---|
| every input known (feature, issue, services) | `sandbox workspace <feature> --issue-id <ref> --services <a,b> [--work-type <t>] [--context-strategy icm] [--autonomous]`. Pass `--task` only to override the issue title |
| the person should review the fields first | the /workspaces pane's Create tab, or the browser form (below) |
| many issues at once | one `sandbox workspace` call per issue, **in sequence** (they share source repos), then run the batch check. Before the first: the `sandbox` CLI runs `$SANDBOX_REPOS_ROOT/sandbox/apps/cli/dist`, so check that checkout is on an up-to-date `main` and rebuilt (`npm run build --workspace apps/cli`), or the batch comes out with stale defaults |
| many issues, run unattended | as above with `--autonomous` on each create. Then start one Claude Code session per workspace folder with the prompt `start the run`, **one at a time**: each new folder raises a trust prompt, and parallel starts collide |

**`autonomous`** (off by default; `--autonomous`, `SANDBOX_AUTONOMOUS=1`, `autonomous: true` in `workspace.yml`, or the form's checkbox): an icm workspace runs stage 01 → `sandbox pr open` with self-checks instead of human checks, and `.claude/settings.json` allows the git/sandbox/docker/gh/node/python3 calls a headless `claude-send "start the run"` needs. Set it only when the person asked for an unattended run — they then review only the PR. Off again: `autonomous: false`, then `sandbox init-workspace`.

**Batch check** — after creating, for each new workspace:

```bash
test -f <ws>/.sandbox/issue.md && grep -q '^## Issue$' <ws>/CLAUDE.md && echo ok
```

Report any workspace that fails it; don't hand-patch files.

The workspace is git worktrees (one per repo, derived from the selected **services**) on a
`<user>/<workspace>` branch under `$SANDBOX_WORKSPACES_ROOT`, followed by `init-workspace`
(writes `CLAUDE.md`, `.env`, `compose.yml`, …).

There is **no hand-maintained schema** — fields are built from the same prompt
definitions (`_WIZARD_PROMPTS` in `packages/sandbox-core/src/workspace_prompts.ts`) that
drive the terminal wizard. So every
surface shows the same fields, labels, defaults, and validation — and the **same look**:
every surface (browser form, dashboard tab, Desktop inline) renders the one shared form
component (`apps/sandbox-dashboard/src/create-form.ts`).

## Which browser shows the form

| Where this session runs | How to open the form |
|-------------------------|----------------------|
| **Claude Code desktop app** (the system prompt says so, and the `mcp__Claude_Browser__*` tools are present) | In the app's own Browser pane: see *Claude Code desktop* below. |
| **VS Code extension**, a **terminal**, or anywhere else | In the system browser: the foreground `--browser-form` command below. Do this even if some browser tool happens to be available. |

## Preferred path — `sandbox workspace --browser-form`

This is the self-contained path; it works in **Claude Code / VS Code** without any
MCP-server connection. It opens the form on localhost in the **system browser** (the same
form, styling, and create path the Desktop MCP App uses), blocks until submit/cancel,
creates the workspace, and prints a single outcome JSON to **stdout** (progress → stderr).

```bash
sandbox workspace --browser-form                      # open the form; create on submit
sandbox workspace --browser-form --issue-id <ref>      # pre-fill from an issue
sandbox workspace --browser-form --open               # also launch VS Code afterward
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
   SANDBOX_FORM_NO_BROWSER=1 sandbox workspace --browser-form 2>/tmp/workspace-form.err >/tmp/workspace-form.out
   ```

2. Read the form URL from the stderr file (the line `[sandbox-workspace] workspace form: http://127.0.0.1:<port>/`).
3. Call `mcp__Claude_Browser__preview_start` with `url` set to that URL. The form loads in
   the browser tab, but no browser tool brings the pane into view: check
   `mcp__Claude_Browser__tabs_context`, and when it says the pane is hidden, tell the user to
   open the Browser pane to see the form. Close any tab left from an earlier form run.
4. Wait for the background command to exit (it blocks until submit, cancel, or timeout), then
   read the outcome JSON from the stdout file and act on it per the table above.

Add `--issue-id`/`--open` to step 1 exactly as for the foreground form.

### Desktop inline alternative — the `workspace` MCP tool

In **Claude Desktop**, the bundled `sandbox-workspace` MCP server renders the form **inline**
(an MCP App `ui://` resource). Calling `mcp__plugin_sandbox-tools_sandbox-workspace__workspace` there shows the
same form in-conversation; on a CLI/VS-Code client it falls back to the same browser
form as `--browser-form`. Use `--browser-form` from Claude Code; reserve the MCP tool for
Desktop.

### Prerequisites
- The `sandbox` CLI on `PATH` (e.g. `~/.local/bin/sandbox`) and `node`.
- The app built once: `npm --prefix apps/sandbox-dashboard run build` (produces `dist/form-cli.js`
  for `--browser-form` and `dist/main.js` for `sandbox dashboard`). Running `sandbox dashboard` once also
  builds it. Without the build, `--browser-form` errors with a clear message.
  The form page (`dist/form.html`) is fully self-contained — no internet needed.

## Common pitfalls

- **Issue can't be read.** The create fails before anything is made; run `sandbox connect`, fix sign-in, retry.
- **No repos resolvable.** The form derives worktree repos from **services**; if none are
  picked, `sandbox workspace` has nothing to make worktrees from and exits nonzero. Pick
  services, or pass `--repos r1,r2` (the form has no repos field).
- **Source repo missing.** Worktrees are cut from `$SANDBOX_REPOS_ROOT/<repo>`; a missing
  checkout fails the create.
- **Workspace already exists.** `sandbox workspace` skips worktree creation and just re-runs
  `init-workspace` (idempotent) — not an error.
- **After creation:** tell the user to `cd <workspace-path>` and open a Claude Code session
  there; the next step is `sandbox up <feature>` from inside the workspace — do not run
  `sandbox up` yourself.
