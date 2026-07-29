# Open Pull Requests tab — design

**Date:** 2026-07-11
**Status:** Approved (pending spec review)
**Surface:** sandbox MCP workspace browser dashboard (`apps/mcp-workspace`)

## Goal

Add a third tab, **"Open Pull Requests"**, to the browser dashboard. It lists open
PRs across the `sandbox` org (younger than one month), split into two sections:
my own PRs and other team members' PRs that are in the human-approval queue. Each PR
is an expandable card showing its body and — where applicable — an **Approve** button
and a **Reconcile with Jira** button that opens an interactive triage session.

Browser surface only. The MCP-inline (`mcp-list.ts`) and Cowork-artifact
(`artifact-main.ts`) surfaces do **not** get this tab — it depends on the same-origin
Express server for its Terminal-launch and Jira-fetch tools.

## Non-goals

- Reject / request-changes from the dashboard. The dashboard only approves; rejection
  happens inside the interactive `pr-approve-triage` terminal session.
- Label mutation on approve. Approve is `gh pr review --approve` only.
- Pagination / infinite scroll. The two sections are bounded (my open PRs + the
  ready-for-approval queue); a name/title filter box is enough.
- A dedicated PR-detail view. Expansion in-place shows everything.

## Sections & filters

The current user is resolved once via `gh api user --jq .login` (already the known
value `jaysonboyer`, but resolved live so the tool isn't hard-coded to one user).

**Section 1 — My open PRs**
`gh search prs --owner=sandbox --author=@me --state=open`, then dropped if
`updatedAt` is older than 30 days.

**Section 2 — Others' ready-for-human-approval**
`gh search prs --owner=sandbox --label=ready-for-human-approval --state=open`,
dropped if older than 30 days, and dropped if `author.login == <me>` (those already
appear in section 1).

> **Label:** the constant is `ready-for-human-approval` — the label the
> `pr-approve-triage` skill keys on. Defined once as `APPROVAL_LABEL` in `sandbox.ts`
> so it is trivial to change if the org convention differs.

The "one month" cutoff is computed server-side as `now - 30 days` against each PR's
`updatedAt`. Both `gh search prs` calls request
`--json url,repository,number,title,updatedAt,author,labels`.

## Per-PR properties

For every PR in both sections, after the search returns the URLs, fan out one
`gh pr view <url> --json reviewDecision,mergeStateStatus,statusCheckRollup,labels,author,number,title,body,headRefName,updatedAt,url`
call per PR (matches the existing `getWorkspacePRs` fan-out with `Promise.all`).

From that, compute:

| Property | Source | Rule |
|----------|--------|------|
| `labels` | `labels[].name` | all label names |
| `changesRequested` | `reviewDecision` | `=== "CHANGES_REQUESTED"` |
| `failingChecks` | `statusCheckRollup[]` | count of entries that are `COMPLETED`/terminal with a conclusion **not** in `{SUCCESS, NEUTRAL, SKIPPED}` (e.g. `FAILURE`, `TIMED_OUT`, `CANCELLED`, `ACTION_REQUIRED`, `STARTUP_FAILURE`) |
| `outOfDate` | `mergeStateStatus` | `=== "BEHIND"` (only explicit BEHIND; `UNKNOWN`/others are not flagged) |
| `body` | `body` | shown on expand |

> **Ceiling (ponytail):** no concurrency cap on the `gh pr view` fan-out, matching the
> existing `getWorkspacePRs` note. Bounded in practice by (my open PRs + the
> ready-for-approval queue). Add a cap if either grows large.

## Server tools (new)

All in `lib/sandbox.ts` (logic) + registered in `server.ts` (MCP surface), following
the existing tool conventions (Zod input/output schema, structured content, text
fallback, `WorkspaceError` handling).

### `open-prs`
- Input: `{}`
- Output: `{ me: string, mine: PR[], others: PR[] }`
- `PR = { url, repo, number, title, author, body, labels: string[], changesRequested: boolean, failingChecks: number, outOfDate: boolean, hasApprovalLabel: boolean, jiraKey: string | null }`
- `jiraKey` parsed server-side from title/body/headRefName via the existing
  `parseJiraKey` regex; `hasApprovalLabel` is `labels.includes(APPROVAL_LABEL)`.

### `pr-approve`
- Input: `{ url: string }`
- Runs `gh pr review <url> --approve`.
- Output: `{ ok: true }` (or `WorkspaceError` on failure).
- No label change.

### `jira-issue`
- Input: `{ ref: string }` (a ticket key or any string containing one)
- Reuses the `claude -p` + `extractJson` + persistent-cache path (same machinery as
  `fetchJiraFormData` / `getJiraStatuses`). Prompt asks for a compact card:
  `{ key, summary, status, type, assignee, description, url }`.
- Output: that object, or `{ key }` alone if the lookup fails (best-effort — never
  blocks the triage launch).

### `pr-triage` (Terminal launch)
- Input: `{ url: string }`
- Opens a macOS Terminal running `claude "/pr-approve-triage <url>"`, `cd`'d to the
  sandbox repo root (the `pr-approve-triage` skill is global, so cwd only
  needs to be a valid repo).
- Reuses a shared helper factored out of `resumeClaudeInTerminal`:
  `openTerminalRunning(script: string)` — the `osascript`/`tell application "Terminal"`
  core. `resumeClaudeInTerminal` is refactored to call it; behavior unchanged.
- Output: `{ ok: true }`.

## UI (`src/prs-ui.ts`, new)

Dependency-free vanilla DOM, same `el()` helper and CSS-injection approach as
`workspace-ui.ts`. Mounted by `browser-main.ts` into a new `#prs` pane. Exposes
`initPrsUI(bridge, root)` and a `reload()` for the tab shell.

### Tab wiring in `browser-main.ts`
- Add `<button class="wsd-tab" data-tab="prs">Open Pull Requests</button>` and a
  `<div class="wsd-pane" data-pane="prs" hidden>`.
- Extend the `"list" | "new"` tab type to include `"prs"`; `tabFromHash` maps
  `#prs`. Lazy-mount on first show (like the create form).
- Document title: `"Open Pull Requests · Sandbox Workspaces"` when active.

### Layout
- Two labeled sections ("My open PRs", "Ready for review"), each with a count and the
  shared filter box (filter by title / repo / label).
- Each PR card:
  - **Head (collapsed):** repo `#number` · title · property chips. Chips reuse the
    existing pill classes where possible (`.lbl` for labels; new `.pr-flag` variants
    for `changes requested` / `N failing` / `out of date`).
  - **Panel (expanded):** PR body rendered as HTML by `markdown-it` (see below),
    then an actions row.
- Actions row:
  - **Approve** button → `pr-approve` `{ url }`. On success, chip/row shows "approved ✓".
  - **Reconcile with Jira** button — rendered only when `hasApprovalLabel`. On click:
    1. call `jira-issue` `{ ref: jiraKey ?? title }`, render the returned fields as an
       inline Atlassian ticket card (key + summary + status pill + type + assignee +
       description). If it fails, show "couldn't read ticket" and continue.
    2. call `pr-triage` `{ url }`; show "Opening Terminal for triage…" then "Terminal
       opened — triage running there."
  - A shared per-card message slot for action status/errors (mirrors `.act-msg`).

### Markdown rendering (`markdown-it`)

The PR body is rendered with **`markdown-it`** — a new dependency of
`apps/mcp-workspace`, imported only by `prs-ui.ts` (which lives in the `browser.html`
bundle, *not* the strict-CSP Cowork artifact, so the added weight is a localhost-only
concern). Full CommonMark + GFM: tables, task-lists, nested lists, code blocks,
autolinks — all the things real PR bodies contain and a hand-rolled subset would miss.

Configured **`html: false`** (the default): any raw HTML in the untrusted PR body is
escaped, not passed through. That single flag makes it XSS-safe with no separate
sanitizer (`dompurify`) needed — the reason `markdown-it` beats `marked`, which dropped
built-in sanitization and would require the extra dep.

`linkify: true` so bare URLs become links; rendered output is assigned via `innerHTML`
into the panel body. A single shared `MarkdownIt` instance is created once at module
load and reused per card.

### Loading
- On mount, call `open-prs`. Show a skeleton/"Loading pull requests…" until it lands.
- A "↻ Refresh" control re-runs `open-prs`.
- The `open-prs` call is the network-heavy one (fan-out of `gh pr view`); the tab
  renders the section shells immediately and fills cards when the call resolves.

## Data flow

```
prs-ui.initPrsUI
  └─ bridge.callTool("open-prs")            → POST /api/tool → MCP open-prs
        └─ gh search prs (mine) ─┐
        └─ gh search prs (label)─┴─→ per-PR gh pr view (fan-out) → PR[]
  render → sections → cards

card "Approve"            → bridge.callTool("pr-approve", {url})
card "Reconcile with Jira"→ bridge.callTool("jira-issue", {ref})  → inline card
                          → bridge.callTool("pr-triage", {url})   → Terminal
```

## Error handling

- `open-prs`: if `gh` is unavailable or a search fails, the tool returns a
  `WorkspaceError`; the tab shows a retry affordance (same pattern as the workspace
  list's cold-open retry). A single PR's `gh pr view` failure degrades that card to
  "details unavailable" rather than failing the whole list.
- `pr-approve` / `pr-triage`: failures surface in the card's message slot; buttons
  re-enable so the action can be retried.
- `jira-issue`: best-effort; a failed lookup shows "couldn't read ticket" and does not
  block the Terminal launch.

## Testing

- `lib/sandbox.ts` gets a `.smoke.mjs` companion (matches `cache.smoke.mjs`,
  `session-picker.smoke.mjs`) exercising the pure logic that has real branches:
  - the failing-checks classifier (bad vs. ignorable conclusions),
  - the `outOfDate` rule,
  - the 30-day cutoff filter,
  - section split (mine vs. others, self-exclusion from section 2).
  These are fed synthetic `gh pr view` JSON so no network is needed.
- Markdown: no test of `markdown-it` itself (it's a maintained lib), but one smoke case
  locks in *our config* — that a body containing raw `<script>` renders escaped (proving
  `html: false` is set), the invariant we actually depend on.
- The `gh`-invoking and Terminal-launching paths are integration-tested by hand
  (start `sandbox mcp`, open the dashboard, exercise the tab) — same as the other
  dashboard tools, which have no unit coverage for their shell-outs.

## Files touched

| File | Change |
|------|--------|
| `apps/mcp-workspace/lib/sandbox.ts` | `getOpenPrs`, `approvePr`, `fetchJiraIssue`, `openTriageTerminal`; factor `openTerminalRunning` out of `resumeClaudeInTerminal`; `APPROVAL_LABEL` constant |
| `apps/mcp-workspace/server.ts` | register `open-prs`, `pr-approve`, `jira-issue`, `pr-triage` |
| `apps/mcp-workspace/src/prs-ui.ts` | **new** — the tab UI; renders PR body via `markdown-it` (`html: false`) |
| `apps/mcp-workspace/src/browser-main.ts` | third tab + `#prs` route + lazy mount |
| `apps/mcp-workspace/package.json` | add `markdown-it` dependency (`@types/markdown-it` dev) |
| `apps/mcp-workspace/lib/open-prs.smoke.mjs` | **new** — pure-logic + markdown-config smoke checks |

## Open questions

None outstanding. Label convention confirmed as `ready-for-human-approval`.
