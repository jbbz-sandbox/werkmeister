# Workspace lifecycle: from first commit to close-out

One process for every workspace, whichever context strategy (`icm` or `jit`) it uses and whichever skill or command was asked to "make a PR". Issue: jbbz-sandbox/werkmeister#133 (absorbs #129).

## Words

Each term means one thing here.

| Term | Meaning |
|---|---|
| **Test** | run each touched service's registry `test:` command; the exit code decides |
| **Exercise** | observe the change in the workspace's running containers; PASS/FAIL per check |
| **Gate** | every pre-Open check below passes |
| **Approve** | the person sets a PR file to `status: approved` |
| **Open** | `werkmeister pr open` creates the PR in the code repo |
| **Merge** | the person merges the PR |
| **Ship** | the merge is part of a release — the work is done here |
| **Verify** | checking the change in production. Defined, not built. |
| **Close out** | `werkmeister close-out`: record, close the issue, remove the workspace, delete merged branches |

## States

```
working → ready → pr-open → merged → shipped → closed-out
                     ↘──────── abandoned ────────↗
```

The state is read from the PR files alone (`lifecycleOf` in `packages/sandbox-core/src/pr_lifecycle.ts`), so the workspaces pane shows it without a network call.

| State | When |
|---|---|
| working | no PR file yet, or some still `draft` |
| ready | every PR file `approved` |
| pr-open | at least one PR file `open` |
| merged | every PR file `merged` or later |
| shipped | every PR file `shipped`, `closed` or `abandoned` |
| abandoned | every PR file `abandoned` |
| closed-out | `closeout.md` exists at the workspace root |

## Rules

1. **The workspace root branch is a record only.** Commit and push it; never open a PR from it, never merge it.
2. **PRs come only from code worktrees**, one per repo touched, each from its PR file.
3. **The gate** (below) passes before a PR opens.
4. **Only `werkmeister pr open` opens PRs.** A PreToolUse hook enforces this.
5. **Auto-fix is always on.** Right after `werkmeister pr open`, in the Claude desktop app: bind the PR to this session (`ccd_pr` `get_status`; `bind_pr` with the PR's URL if it isn't bound), then turn on Auto-fix with `ccd_pr` `set_monitor` (`auto_fix: true`, `address_comments: true`, the PR's `url`). Don't ask first. Never turn on auto-merge.
6. **Merge is the person's act.** Tooling never merges.
7. **Close out only once every PR file is `shipped`, `closed` or `abandoned`.**

Each workspace gets these as `_shared/pr-rules.md` (ICM) or `.werkmeister/pr-rules.md` (JIT), routed from its `CLAUDE.md`.

## PR files

One per code repo touched, named `pr-<repo>.md`, where `<repo>` is the code worktree's directory name.

- ICM: `stages/NN_propose/output/`. Workspaces generated before the rename use `NN_ship/`.
- JIT: `.werkmeister/notes/`. Not a note: notes are named `NNN-*`.

```markdown
---
repo: jbbz-sandbox/werkmeister     # the code repo on GitHub; never the workspace repo
branch: jayboyer/sandbox-133-workspace-pr-lifecycle
base: main
status: draft                  # draft | approved | open | merged | shipped | closed | abandoned
url:                           # written by werkmeister pr open
merge_sha:                     # written by werkmeister pr status
release:                       # the release tag that shipped it, written by werkmeister pr status
reason:                        # required for closed / abandoned
skip_tests: {}                 # <service>: <reason> — for a service with no test command or no running container
skip_release:                  # <reason> — skips the gate's release check; a ship: tag repo still waits for its release tag
session:                       # the Claude Code session that ran werkmeister pr open (PR callbacks, below)
host_session:                  # its desktop app id (local_…), only when opened from the desktop app
notified:                      # the last status that session was told
---
# feat(cli): owner/repo#133 Workspace PR lifecycle
<body: summary, test and exercise results, acceptance table, Fixes owner/repo#133>
```

The first `#` heading is the PR title and the rest is the body. The person sets `draft → approved`; tooling writes every other status and never infers `approved`. In an `autonomous` icm workspace the agent sets it after its self-check and lists its decisions under `## Recommendations for reviewer` in the body, so the person's review happens on the PR itself ([context-strategies.md](context-strategies.md#autonomous-175)).

## The gate

`werkmeister pr gate [repo]` runs the checks and changes nothing. `werkmeister pr open` runs them again before opening.

| Check | Passes when |
|---|---|
| stages | ICM: every stage before propose has output. JIT: no open decision notes. |
| acceptance | the PR body has a `PASS` table cell and no `FAIL` cell |
| clean | `git status --porcelain` in the code worktree is empty |
| test `<svc>` | the registry command for each touched service exits 0. It runs with `docker exec` in the service's container, because the worktree is mounted at `/app` with its `node_modules`. A service with no command, or with no running container for its repo, fails unless `skip_tests` names it with a reason. |
| exercise | `exercise.md` (ICM: any stage output; JIT: `.werkmeister/notes/`) has a `PASS` cell and no `FAIL` |
| baseline `<svc>` | the touched local service's container is running; for `api`/`web` services, its `health_endpoint` also answers below 400 |
| release | for a `ship: tag` repo with a `release_check`, that command exits 0, unless `skip_release` gives a reason. `skip_release` affects only this check; `werkmeister pr status` still waits for the release tag. |
| approved | `status: approved` |

**Touched services** come from `git diff --name-only origin/<base>...HEAD`. Each file maps to a service through the registry's `repos.<repo>.path_mappings`, by longest prefix. A file under one of the repo's `no_service_paths` (registry `repo:`, below) touches no service, so a docs-only diff runs no service tests; the release check still runs. Any other file under no mapping marks every service in the repo as touched.

The test commands also appear in `.werkmeister/sandbox-context.md` under "Test commands".

## Ship detection (registry `repo:`)

A repo's registry fragment (`<repo>/.sandbox/services.yaml`) says when its merges count as shipped:

```yaml
repo:
  ship: tag                                   # merge (default) | tag
  release_tag: "werkmeister@*"  # glob for git tag --list; required for ship: tag
  release_check: npx changeset status --since=origin/main
  no_service_paths: [docs, .changeset, .gitignore, README.md]  # prefixes that touch no service in the gate
```

`werkmeister registry sync` merges this into `repos.<repo>` of `~/.werkmeister/services.yaml`.

- With `ship: merge`, a merged PR is shipped as soon as it merges.
- With `ship: tag`, it is shipped once a tag matching `release_tag` contains its merge commit (`git tag --contains`).
- `release_check` stops a PR that would never reach a release. For changesets, a branch that changes a package without a changeset fails it.

## Commands

| Command | Does |
|---|---|
| `werkmeister pr gate [repo]` | run the gate, change nothing |
| `werkmeister pr open [repo]` | for each `approved` PR file: gate, push the branch, reuse or create the PR, write `status: open` and `url`, move the issue to `in_review` ([Issue status](#issue-status)), commit and push the PR file on the record branch |
| `werkmeister pr status` | for `open` files, read `gh pr view` and write `merged` + `merge_sha` or `closed`, and `review: changes_requested` while a review asks for changes. For `merged` files, write `shipped` (+ `release`) per the registry. Moves the issue per [Issue status](#issue-status). Commits and pushes the changed PR files on the record branch. |
| `werkmeister issue start` | the first stage or phase began: move the workspace's issue to `in_progress` ([Issue status](#issue-status)) |
| `werkmeister pr adopt <pr-number\|url> [repo]` | for a fix that landed outside the workspace: write `pr-<repo>.md` from `gh pr view` (`repo`, `branch`, `base`, title, `url`, `merge_sha`, `status: merged`, or `open` for an open PR, and `adopted: true`), then run `pr status` on it. `repo` defaults to the workspace's only code worktree. Refuses if the PR file exists or the PR closed unmerged. |
| `werkmeister pr watch` | from anywhere: one PR callback pass (below) over every workspace, for terminal sessions, then one idle-reaper pass ([Containers after a PR](#containers-after-a-pr)). `werkmeister setup` offers to run it every 10 minutes (launchd on macOS, a crontab line elsewhere). `werkmeister pr watch --install` / `--uninstall` add or remove that schedule directly. Logs: `~/.werkmeister/pr-watch.log` |
| `werkmeister pr adopt --no-pr "<reason>" [repo]` | for a fix already on base with no PR: write a `closed` PR file with the reason |
| `werkmeister close-out [name] [--abandon "<reason>"]` | end the workspace (below). The one end-of-workspace verb |
| `werkmeister remove-workspace <name>` | deprecated alias, kept for one release: prints "use `werkmeister close-out --abandon`" and removes as before |

The workspaces pane shows the state on each card. It offers **↻ PRs** (`werkmeister pr status`) while a PR is open or merged, and one end button, which asks twice:

- **✓ Close out** once every PR is shipped (or closed / abandoned), or for a spike with no PR files;
- **✕ Abandon…** otherwise, with a reason field the second press needs filled.

The workspaces MCP server has the same actions as `workspace-pr` and `close-out` (with an optional `abandon` reason).

## PR callbacks

`werkmeister pr open` records which session opened each PR (`session`, plus `host_session` inside the desktop app), from the `CLAUDE_CODE_SESSION_ID` / `CLAUDE_CODE_HOST_SESSION_ID` Claude Code gives its commands; run by hand, it records the workspace's newest session. Every workspace gets one; there is no flag.

A pass runs `werkmeister pr status` for each workspace with a callback and tells the session once per change:

| Status | Message |
|---|---|
| merged | PR <url> merged. Run `werkmeister pr status`, then follow the workspace router. |
| shipped | PR <url> shipped in <tag>. Ask the person whether to run `werkmeister close-out`. |
| closed | PR <url> was closed. Report it to the person. |

`notified` is written before the message goes out, so a failed delivery is logged and not repeated. Once the PR is shipped, closed or abandoned the callback fields are removed. A pass never merges and never closes out.

- Desktop sessions: the werkmeister mod runs a pass when a desktop session starts and every 10 minutes, and sends each message through the app (a visible turn in that session). While the app is closed they wait.
- Terminal sessions: `werkmeister pr watch` resumes them headlessly (`claude -p --resume <session>`, run in the workspace folder), on the schedule `werkmeister setup` installs ([Commands](#commands)). A session id the workspace no longer has is reported, never swapped for another session.

One lock file, `~/.werkmeister/pr-callbacks.lock`, lets one pass run at a time.

## Containers after a PR

A workspace's feature containers stop (SW-39) at these points. Stopping keeps the containers, the slot and the volumes, and `werkmeister up` brings them back. Shared infra is never stopped.

- `werkmeister pr open`: once a pass opens a PR and nothing in it failed. If any file failed its gate or push, the containers stay up so the session can fix it. A session woken for a CI fix runs `werkmeister up` before it re-gates.
- `werkmeister pr status`: when a pass records a PR as merged or shipped.
- The idle reaper: `werkmeister stop --idle <minutes> [feature]` stops each feature that nothing has used for that many minutes. Without `[feature]` it covers every workspace. Something counts as use when:
  - a Claude session in the workspace is busy, or became idle less than N minutes ago (an open session that has sat idle longer does not keep the containers);
  - a container started less than N minutes ago;
  - the gate ran a `docker exec` less than N minutes ago (it touches `.werkmeister/last-exec`).

Every PR callback pass (the werkmeister mod's 10-minute timer and `werkmeister pr watch`) ends with one reaper pass, using N from `overrides.idle_stop_minutes` in `~/.werkmeister/config.yaml`. The default is 30, and `0` turns the reaper off. The pass takes its own lock, `~/.werkmeister/idle-stop.lock`.

A `docker exec` typed by hand in a terminal outside Claude is not seen.

`auto_stop` (a SessionEnd hook, `werkmeister stop --if-idle`) is on by default for `autonomous` workspaces. Set `auto_stop: false` in `.werkmeister/workspace.yml` to turn it off.

## Issue status

The workspace's issue (`issue_id` in `workspace.yml`) moves by itself as the work does (SW-27). Each move happens at one lifecycle point and posts a short comment naming its trigger.

| Lifecycle point | Point | Jira (default) | GitHub (default) | Comment |
|---|---|---|---|---|
| Workspace created | — | no change | no change | — |
| First stage or phase starts: `werkmeister issue start`, run by ICM's first stage contract and JIT's `sb-research` | `in_progress` | `In Progress` | label `status: in progress` | `Work started: stage 01_research in workspace <name>.` |
| `werkmeister pr open` | `in_review` | `In Review` | label `status: in review` | `PR opened: <url>` |
| A review asks for changes (`pr status`: `reviewDecision` or a latest review `CHANGES_REQUESTED`) | `in_progress` (back) | `In Progress` | label `status: in progress` | `Changes requested: <url>` |
| The changes-requested review clears while the PR is open | `in_review` | `In Review` | label `status: in review` | `Back in review: <url>` |
| PR closed without merging, and no other PR open | `in_progress` (back) | `In Progress` | label `status: in progress` | `PR closed without merging: <url>` |
| Every PR merged | `merged` | no change | no change | `Merged: <url>` |
| Shipped: every PR settled, one shipped (release tag contains the merge, or merged where `ship: merge`) | `done` | `Done` | close as completed | `Shipped: <release> — <url>` |
| `werkmeister close-out` | `done` if not already | `Done` | close if still open | `Shipped: …` |
| `werkmeister close-out --abandon "<reason>"` | `abandoned` | no status, comment only | close as not planned | `Abandoned: <reason>` |
| Spike | `done` at close-out | `Done` | closed | `Shipped: no PRs` |

`pr status` runs by hand and in every PR watch pass, so the ship move needs no person.

**Config.** One map in `~/.werkmeister/config.yaml`; each value is a Jira status name, a GitHub label, or `null` to skip that point:

```yaml
overrides:
  issue_statuses:
    in_progress: In Progress
    in_review: In Review
    merged: null
    done: Done
    abandoned: Won't Do
```

A key left out takes its default (table above). `issue_review_status` and `issue_done_status`, the keys before this map, still set `in_review` and `done` when the map doesn't name them. On GitHub, `closed` / `done` / `completed` closes the issue as completed, `not planned` closes it as not planned, and anything else is a label.

**Rules.**

- **Forward only.** The issue's position comes from Jira's status category (`new` / `indeterminate` / `done`) and status name, or GitHub's open/closed state and `status:` label: new < in progress < in review < merged < done. A move applies only when it is ahead of that, apart from the two backward moves to `in_progress` above, which never leave done. Re-running init, a stage or `pr open` never drags an issue back. An issue that can't be read is not moved.
- **One status label on GitHub.** Adding a `status:` label removes the issue's other `status:` labels, and creates the label if the repo lacks it.
- **Refusals warn.** No transition, no credentials, a status missing from the workflow: the move prints a warning naming the configured status and, for Jira, the transitions available, and the stage, PR open or close-out carries on.

## The PR guard

Every workspace's `.claude/settings.json` gets one managed PreToolUse hook, `werkmeister hooks pr-guard`, with matcher `Bash|mcp__.*create_pull_request`. It is installed by `werkmeister up` / `init-workspace` for both strategies.

- Inside a workspace (any folder under one holding `.werkmeister/workspace.yml`), it denies `gh pr create` in Bash and the GitHub MCP's `create_pull_request`. The deny message points to `werkmeister pr open`.
- This is what stops `/create-pr`, `superpowers:finishing-a-development-branch` or a raw `gh` call from opening a PR on the wrong repo or skipping the gate.
- `werkmeister pr open` runs `gh` itself, not through the Bash tool, so the guard never sees it.
- The `werkmeister:workspace-pr` skill and the `sb-pr` skill steer toward the right path before the guard has to fire.

## Close-out

`werkmeister close-out` is the only way to end a workspace. It has two outcomes.

**Shipped.** Without `--abandon`, it refuses unless the workspace is `shipped` or `abandoned`. A `spike` with no PR files is also allowed, and so is `closed-out` (a `closeout.md` exists but the removal failed), which retries. Then, in order:

1. **Issue.** The safety net: if the workspace has one and it isn't already done (shipping normally moved it), move it to `done` ([Issue status](#issue-status)). The comment names the release and PR. A tracker refusal is a warning in the output and in `closeout.md`; close-out goes on.
2. **Record.** Write `closeout.md`: one row per PR (repo, URL, status, merge SHA, release, reason) plus the issue line.
3. **Remove.** `removeWorkspace`, the internal step: commit and push every branch (the record branch now carries `closeout.md`), `werkmeister down`, reload the proxy, delete the directory, prune the worktrees. If any push fails, nothing is deleted.
4. **Branches.** Delete each merged code branch locally, and on origin if it is still there (GitHub's "delete branch on merge" may have done it already). An `adopted` PR's branch was never the workspace's, so it is kept. The record branch is kept.

**Abandoned.** `werkmeister close-out <name> --abandon "<reason>"` ends a workspace whose work won't ship. The reason is required.

1. Every unsettled PR file becomes `abandoned` with the reason.
2. The issue gets a comment with the reason and moves to `abandoned` when one is configured (GitHub: closed as not planned). A refusal is a warning.
3. `closeout.md` records the reason.
4. Remove, as above: every branch is pushed, so no work is lost.
5. Every branch is kept.

The `abandoned` PR status is the record of this, not a second way in. A workspace whose PR files are already all `abandoned` closes out the same way without the flag.

### Sessions

The workspace's Claude sessions are cleaned up as part of close-out:

- **Desktop sessions.** The pane and the `close-out` MCP tool (through the werkmeister plugin) call `archive_session` on every desktop session whose cwd is in the workspace. The desktop app may refuse some, such as a pinned session, the one on screen, or an archive you declined outside auto mode. Each refusal is reported as "left open"; it doesn't fail the close-out. The CLI and VS Code can't reach the app, so they tell you to archive these from the sidebar.
- **Terminal sessions.** `claude` running in a terminal can't be archived from outside. Every surface lists those still open in the workspace (`terminal session: pid … on ttys… in <dir> — /exit it`) so you can exit them.

## Spikes

A spike has no propose stage and no PR files. When `findings.md` is recorded where it is needed (the next workspace's brief, or the issue), `werkmeister close-out` removes the workspace.
