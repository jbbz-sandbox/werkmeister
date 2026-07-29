---
name: sandbox-workspace
description: "Create a brand-new sandbox workspace (git worktrees on a <user>/<workspace> branch + init). Use when the user says '/sandbox-workspace', 'create a workspace', 'new sandbox workspace', 'spin up a workspace', 'make a workspace for <TICKET-ID>', or any request to create/bootstrap a new sandbox workspace from scratch."
---

# Sandbox Workspace

Create a brand-new sandbox workspace by collecting inputs through a form, then
running `sandbox workspace`. The workspace is git worktrees (one per repo, derived from
the selected **services**) on a `<user>/<workspace>` branch under
`$SANDBOX_WORKSPACES_ROOT`, followed by `init-workspace` (writes `CLAUDE.md`, `.env`,
`docker-compose.yml`, …).

There is **no hand-maintained schema** — fields come from `sandbox workspace
--print-form-schema`, derived from the same prompt definitions (`_WIZARD_PROMPTS` in
`src/commands/init_workspace.ts`) that drive the terminal wizard. So every
surface shows the same fields, labels, defaults, and validation — and the **same look**:
every surface (browser form, dashboard tab, Desktop inline) renders the one shared form
component (`apps/sandbox-dashboard/src/create-form.ts`).

## Preferred path — `sandbox workspace --browser-form`

This is the self-contained path; it works in **Claude Code / VS Code** without any
MCP-server connection. It opens the form on localhost (the same form, styling, and create
path the Desktop MCP App uses), blocks until submit/cancel, creates the
workspace, and prints a single outcome JSON to **stdout** (progress → stderr).

```bash
sandbox workspace --browser-form                      # open the form; create on submit
sandbox workspace --browser-form --jira-id PROJ-1234   # pre-fill from a Jira ticket
sandbox workspace --browser-form --open               # also launch VS Code afterward
```

Run it in the **foreground** with a generous Bash timeout (~900000 ms) — it blocks while the
user fills the form (default 600s wait) plus worktree creation + init.

Outcome JSON shapes:

| Shape | Action |
|-------|--------|
| `{"status":"submitted","create":{"ok":true,"result":{…}}}` | Success — `result.workspacePath` is the new dir. |
| `{"status":"submitted","create":{"ok":false,"error":"…"}}` | CLI failed — show `error`, offer to fix + retry. |
| `{"status":"cancelled"}` / `{"status":"timeout"}` | Nothing created — offer to re-run. |
| `{"status":"error","message":"…"}` | Pre-form failure (e.g. app not built) — relay it. |

### Desktop inline alternative — the `workspace` MCP tool

In **Claude Desktop**, the bundled `sandbox-workspace` MCP server renders the form **inline**
(an MCP App `ui://` resource). Calling `mcp__sandbox-workspace__workspace` there shows the
same form in-conversation; on a CLI/VS-Code client it falls back to the same browser
form as `--browser-form`. Use `--browser-form` from Claude Code; reserve the MCP tool for
Desktop.

### Prerequisites
- The `sandbox` CLI on `PATH` (e.g. `~/.local/bin/sandbox`) and `node`.
- The app built once: `npm --prefix apps/sandbox-dashboard run build` (produces `dist/form-cli.js`
  for `--browser-form` and `dist/main.js` for `sandbox mcp`). Running `sandbox mcp` once also
  builds it. Without the build, `--browser-form` errors with a clear message.
  The form page (`dist/form.html`) is fully self-contained — no internet needed.

## Skip the form — direct CLI

If the user already gave every input, skip the form:

```bash
sandbox workspace add-pricing --jira-id PROJ-1234 --services rest-hello,next-hello
```

`feature` is positional; other form keys map 1:1 onto flags (`jira_id` → `--jira-id`,
`services` → `--services`, `test_path` → `--test-path`, …). Add `--repos r1,r2` to force
worktrees for repos beyond what the selected services imply (the form has no repos field —
it derives repos from services).

## Common pitfalls

- **No repos resolvable.** The form derives worktree repos from **services**; if none are
  picked, `sandbox workspace` has nothing to make worktrees from and exits nonzero. Pick
  services, or pass `--repos`.
- **Source repo missing.** Worktrees are cut from `$SANDBOX_REPOS_ROOT/<repo>`; a missing
  checkout fails the create.
- **Workspace already exists.** `sandbox workspace` skips worktree creation and just re-runs
  `init-workspace` (idempotent) — not an error.
- **After creation:** tell the user to `cd <workspace-path>` and open a Claude Code session
  there; the next step is `sandbox up <feature>` from inside the workspace — do not run
  `sandbox up` yourself.
