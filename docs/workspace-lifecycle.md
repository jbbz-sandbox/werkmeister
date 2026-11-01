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
| **Close out** | `werkmeister workspace close`: record, close the issue, remove the workspace, delete merged branches |

## States

```
working → ready → pr-open → merged → shipped → closed-out
                     ↘──────── abandoned ────────↗
```

The state is read from the PR files alone (`lifecycleOf` in `packages/werkmeister-core/src/pr_lifecycle.ts`), so the workspaces pane shows it without a network call.

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
5. **Auto-fix is always on.** `werkmeister pr watch` wakes the session that opened the PR when a check fails, a review comes in or the PR conflicts with its base, with the cause in the message. Don't turn on Auto-fix in the Claude desktop app (`ccd_pr`). Never turn on auto-merge.
6. **Merge is the person's act.** Tooling never merges. Squash is the default. A PR whose commit SHAs must survive (e.g. a commit listed in `.git-blame-ignore-revs`) says "Merge with a merge commit" at the top of its body, and the person merges it that way; squash and rebase both rewrite SHAs.
7. **Close out only once every PR file is `shipped`, `closed` or `abandoned`.**

Each workspace gets these as `_shared/pr-rules.md` (ICM) or `.werkmeister/pr-rules.md` (JIT), routed from its `CLAUDE.md`.

## PR files

One per code repo touched at a time, named `pr-<worktree>[-<slug>].md`, where `<worktree>` is the code worktree's directory name. The first PR for a worktree is `pr-<worktree>.md`; a follow-up adds a slug ([Follow-up PR](#follow-up-pr)).

- ICM: `stages/NN_propose/output/`. Workspaces generated before the rename use `NN_ship/`. A template with neither (spike) uses its last stage's `output/` ([Spikes](#spikes)).
- JIT: `.werkmeister/notes/`. Not a note: notes are named `NNN-*`.

```markdown
---
worktree: werkmeister           # the code worktree; optional for pr-<worktree>.md, written by werkmeister pr new
repo: jbbz-sandbox/werkmeister     # the code repo on GitHub; never the workspace repo
branch: jayboyer/werkmeister-133-workspace-pr-lifecycle
base: main
status: draft                  # draft | approved | open | merged | shipped | closed | abandoned
url:                           # written by werkmeister pr open
merge_sha:                     # written by werkmeister pr status
release:                       # the release tag that shipped it, written by werkmeister pr status; `none` when the gate's release check found nothing to bump, written by werkmeister pr open
reason:                        # required for closed / abandoned
skip_tests: {}                 # <service>: <reason> — for a service with no test command or no running container; tests: <reason> when no service maps to the changed files
skip_release:                  # <reason> — skips the gate's release check; a ship: tag repo still waits for its release tag
skip_exercise:                 # <reason> — skips the gate's exercise check, e.g. a doc deliverable with nothing to run
session:                       # the Claude Code session that ran werkmeister pr open (PR callbacks, below)
host_session:                  # its desktop app id (local_…), only when opened from the desktop app
notified:                      # the last status that session was told
notified_checks:               # written by pr watch: <head sha>: <failing checks announced on it>
notified_review:               # written by pr watch: time of the newest review or comment announced
notified_conflict:             # written by pr watch while an announced conflict lasts
---
# feat(cli): owner/repo#133 Workspace PR lifecycle
<body: summary, test and exercise results, acceptance table, Fixes owner/repo#133>
```

The first `#` heading is the PR title and the rest is the body. The person sets `draft → approved`; tooling writes every other status and never infers `approved`. In an `autonomous` icm workspace the agent sets it after its self-check and lists its decisions under `## Recommendations for reviewer` in the body, so the person's review happens on the PR itself ([context-strategies.md](context-strategies.md#autonomous-175)).

### Follow-up PR

Code written after a worktree's PR merged, e.g. a problem found while cutting or deploying the release, or review feedback that lands after merge, goes in a follow-up PR from the same workspace (SW-103).

- `werkmeister pr new <worktree> --slug <slug>` fetches the base and cuts `<branch>-<slug>` from `origin/<base>`. It cuts from base, not from the merged branch, because a squash merge leaves that branch's commits off base. It then writes `pr-<worktree>-<slug>.md` at `status: draft`, with `worktree`, `repo`, `branch` and `base` taken from the worktree's first PR file, and commits it on the record branch.
- It refuses while any other PR file for that worktree is not yet `merged`, `shipped`, `closed` or `abandoned`, since the worktree holds one branch at a time. It also refuses on uncommitted changes.
- From there the follow-up is an ordinary PR file: fill the title, body and acceptance table, the person approves it, `pr gate` / `pr open` / `pr status` handle it. A merged first PR stops being gated once the follow-up exists. `pr open` refuses a branch an earlier PR of the same worktree already used, since GitHub deleted it on merge and pushing it again recreates it.
- The gate's exercise check reads the run's `exercise.md`, so put the follow-up's own test and exercise results in its PR body, or set `skip_exercise` with the reason.
- The lifecycle composes over every file: the workspace reads `working` while the follow-up is a draft, `pr-open` while it is open, and `shipped` once every file is settled. Close-out waits for all of them.
- If the issue is already Done, `pr open` comments `Follow-up PR opened: <url>` and leaves it Done ([Issue status](#issue-status)).
- After close-out the workspace is gone; a later fix needs a new workspace.

## The gate

`werkmeister pr gate [repo]` runs the checks and changes nothing. `werkmeister pr open` runs them again before opening. The PR-file checks (stages, acceptance, approved) run first. If one fails, the gate stops there and reports `tests: not run`, so a malformed PR file never waits on the test commands (SW-150).

| Check | Passes when |
|---|---|
| stages | ICM: every stage before the one holding PR files has output. JIT: no open decision notes. |
| acceptance | the PR body has a `PASS` table cell and no `FAIL` cell. The result cell holds exactly `PASS` or `FAIL`, with evidence in its own column: `\| criterion \| PASS \| evidence \|`. `\| criterion \| PASS: repro.md §1 \|` has no `PASS` cell. |
| clean | `git status --porcelain` in the code worktree is empty |
| lint | when the repo's registry `repo:` sets `lint`, that command exits 0, for any diff. It runs from the repo root in one of the repo's containers, like the release check. A failure shows the last 15 lines of output. No `lint` key means no row (SW-133). |
| test `<svc>` | the registry command for each touched service exits 0. It runs with `docker exec` in the service's container, or in any running container of its repo, because they all mount the worktree at `/app` with its `node_modules`. When the repo has none running, the gate starts one (`docker compose up -d --wait <svc>`, preferring a cli/library/extension service, which only sleeps) and stops it when the gate ends, pass or fail. When the branch's own fragment renders a touched service differently from `compose.yml` (a new `environment:` entry, `node_modules_volume`, image, …), the gate starts that service from a gate-only `compose.gate.yml` rendered from the branch, runs its checks there, then recreates it from `compose.yml` (or stops it, if it wasn't running) and deletes the file (SW-118). A service with no command, or one whose container could not be started, fails unless `skip_tests` names it with a reason. |
| tests | when the diff is non-empty, touches no service, and has files outside `no_service_paths` (the registry has no `repos:` entry, or no `services` for the worktree), the gate fails a `tests` row naming those files, unless `skip_tests: { tests: <reason> }` is set. An empty or docs-only diff gets no row (SW-278). |
| exercise | `exercise.md` (ICM: any stage output; JIT: `.werkmeister/notes/`) has a `PASS` cell and no `FAIL`, unless `skip_exercise` gives a reason. In a table with a `result` column, every result cell is exactly `PASS`: `FAIL — reason` is a FAIL row, and any other text fails too (SW-247). The acceptance check applies the same rule. |
| baseline `<svc>` | for a touched local `api`/`web` service: its own container is running and its `health_endpoint` answers below 400 |
| release | for a `ship: tag` repo with a `release_check`, that command exits 0, unless `skip_release` gives a reason. `skip_release` affects only this check; `werkmeister pr status` still waits for the release tag. When the check runs and reports nothing to bump (changesets' `NO packages to be bumped`), `werkmeister pr open` writes `release: none`. |
| approved | `status: approved` |

**Touched services** come from `git diff --name-only origin/<base>...HEAD`. Each file maps to a service through the registry's `repos.<repo>.path_mappings`, by longest prefix. A file under one of the repo's `no_service_paths` (registry `repo:`, below) touches no service, so a docs-only diff runs no service tests; the release check still runs. Any other file under no mapping marks every service in the repo as touched.

The test commands also appear in `.werkmeister/werkmeister-context.md` under "Test commands".

## Ship detection (registry `repo:`)

A repo's registry fragment (`<repo>/.werkmeister/services.yaml`) says when its merges count as shipped:

```yaml
repo:
  ship: tag                                   # merge (default) | tag
  release_tag: "werkmeister@*"  # glob for git tag --list; required for ship: tag
  release_check: pnpm changeset status --since=origin/main
  lint: pnpm exec biome ci .                  # the gate's lint row; any ship mode
  no_service_paths: [docs, .changeset, .gitignore, README.md]  # prefixes that touch no service in the gate
```

`werkmeister registry sync` merges this into `repos.<repo>` of `~/.werkmeister/services.yaml`.

- With `ship: merge`, a merged PR is shipped as soon as it merges.
- With `ship: tag`, it is shipped once a tag matching `release_tag` contains its merge commit (`git tag --contains`). A PR file with `release: none` needs no release, so it is shipped as soon as it merges.
- `release_check` stops a PR that would never reach a release. For changesets, a branch that changes a package without a changeset fails it.
- `lint` is the repo's lint/format check (the gate's `lint` row). Set it to CI's own command so a format error fails before the PR opens.

## Commands

| Command | Does |
|---|---|
| `werkmeister pr gate [repo]` | run the gate, change nothing. Skips a merged PR file whose worktree has a follow-up in progress. `repo` is a worktree (its PR files) or one PR file's name (`werkmeister-why-page`), for every `pr` action |
| `werkmeister pr open [repo]` | for each `approved` PR file: gate, push the branch, reuse or create the PR, write `status: open` and `url`, move the issue to `in_review` ([Issue status](#issue-status)), commit and push the PR file on the record branch |
| `werkmeister pr status` | for `open` files, read `gh pr view` and write `merged` + `merge_sha` or `closed`, and `review: changes_requested` while a review asks for changes. For `merged` files, write `shipped` (+ `release`) per the registry. Moves the issue per [Issue status](#issue-status). Commits and pushes the changed PR files on the record branch. |
| `werkmeister pr new <worktree> --slug <slug>` | after that worktree's PRs merged: cut `<branch>-<slug>` from `origin/<base>` and write a draft `pr-<worktree>-<slug>.md` ([Follow-up PR](#follow-up-pr)) |
| `werkmeister issue start` | the first stage or phase began: move the workspace's issue to `in_progress` ([Issue status](#issue-status)), then fast-forward each code worktree with no commits of its own to `origin/<base>`, or print how far behind it is |
| `werkmeister pr adopt <pr-number\|url> [repo]` | for a fix that landed outside the workspace: write `pr-<repo>.md` from `gh pr view` (`repo`, `branch`, `base`, title, `url`, `merge_sha`, `status: merged`, or `open` for an open PR, and `adopted: true`), then run `pr status` on it. `repo` defaults to the workspace's only code worktree. When `pr-<repo>.md` is taken, writes `pr-<repo>-<number>.md` with `worktree: <repo>`. Refuses if a PR file already has that PR's URL, or the PR closed unmerged. |
| `werkmeister pr watch` | from anywhere: one PR callback pass (below) over every workspace, for terminal sessions: status changes, and failed checks, reviews and conflicts on open PRs, then one idle-reaper pass ([Containers after a PR](#containers-after-a-pr)). `werkmeister machine setup` offers to run it every 10 minutes (launchd on macOS, a crontab line elsewhere). `werkmeister pr watch --install` / `--uninstall` add or remove that schedule directly. Logs: `~/.werkmeister/pr-watch.log` |
| `werkmeister pr adopt --no-pr "<reason>" [repo]` | for a fix already on base with no PR: write a `closed` PR file with the reason |
| `werkmeister workspace close [name]`, `werkmeister workspace abandon "<reason>" [name]` | end the workspace (below): shipped, or not |
| `werkmeister remove-workspace <name>` | deprecated alias, kept for one release: prints "use `werkmeister workspace abandon`" and removes as before | <!-- docs-check: ignore -->

The workspaces pane shows the state on each card. It offers **↻ PRs** (`werkmeister pr status`) while a PR is open or merged, and one end button, which asks twice:

- **✓ Close out** once every PR is shipped (or closed / abandoned), or for a spike with no PR files;
- **✕ Abandon…** otherwise, with a reason field the second press needs filled.

The workspaces MCP server has the same actions as `workspace-pr` and `close-out` (with an optional `abandon` reason).

## PR callbacks

`werkmeister pr open` records which session opened each PR (`session`, plus `host_session` inside the desktop app), from the `CLAUDE_CODE_SESSION_ID` / `CLAUDE_CODE_HOST_SESSION_ID` Claude Code gives its commands; run by hand, it records the workspace's newest session. Every workspace gets one; there is no flag.

A pass runs `werkmeister pr status` for each workspace with a callback and tells the session once per change:

| Status | Message |
|---|---|
| merged | PR `<url>` merged. Run `werkmeister pr status`, then follow the workspace router. |
| shipped | PR `<url>` shipped in `<tag>`. Ask the person whether to run `werkmeister workspace close`. |
| closed | PR `<url>` was closed. Report it to the person. |

`notified` is written before the message goes out, so a failed delivery is logged and not repeated. Once the PR is shipped, closed or abandoned the callback fields are removed. A pass never merges and never closes out.

While the PR is open, the same pass also wakes the session when it needs work (rule 5), all new events in one message:

| Event | Message starts | Cause in the message | Claimed in |
|---|---|---|---|
| a check on the head commit fails (`FAILURE`, `TIMED_OUT`, `STARTUP_FAILURE`; a status `FAILURE`/`ERROR`) | check `<name>` failed on PR `<url>`, fix it. | the first error lines of `gh run view --job <id> --log-failed` | `notified_checks`: the head SHA and the names announced on it. A new head announces every failing check again |
| a CHANGES_REQUESTED review, a review or PR comment, or an inline comment | address the review on PR `<url>`: | the comments, quoted (`path:line` for inline ones) | `notified_review`: the time of the newest one. `pr open` sets it, so an early review still counts; a PR opened before this keeps its old comments as history |
| `mergeable` is `CONFLICTING` | PR `<url>` conflicts with `<base>`, resolve it. | `git log --oneline HEAD..origin/<base>` | `notified_conflict`, cleared once GitHub reports it mergeable again, so a later conflict counts |

Comments carrying the Claude Code footer (`Generated with [Claude Code]`) are the session's own replies and don't wake it. A merged or closed PR gets its status message, not a wake.

- Desktop sessions: the werkmeister mod runs a pass when a desktop session starts and every 10 minutes, and sends each message through the app (a visible turn in that session). While the app is closed they wait.
- Terminal sessions (VS Code included: only the desktop app sets `host_session`): `werkmeister pr watch` resumes them headlessly (`claude -p --resume <session>`, run in the workspace folder), on the schedule `werkmeister machine setup` installs ([Commands](#commands)). A session id the workspace no longer has is reported, never swapped for another session. A session whose transcript changed in the last 5 minutes is in use: its message is held unclaimed (`wake held` in the log) and goes out on the first pass after it has gone quiet, so a headless turn never runs beside a live one.

One lock file, `~/.werkmeister/pr-callbacks.lock`, lets one pass run at a time.

## Check-in

The `check-in` MCP tool (behind the root `/check-in` skill) reports PR and release state for every workspace the label filter keeps, so the root session sees a release without anyone announcing it (SW-65).

Before it reports, it ships merged PRs: for each kept workspace with a `merged` PR file it runs the `pr status` pass without `gh` — the same rule as [Ship detection](#ship-detection-registry-repo) (`git fetch --tags`, then `git tag --contains <merge_sha> --list <release_tag>`), recording `release`, moving the issue and committing the record as `pr status` does. Open → merged stays with `pr status` and the callback pass. A version-bump PR that merged before the changesets release job published its tag stays `merged`. It takes the callback lock above and skips the pass while another one holds it. A PR it ships still gets its callback message from the next pass.

| Field | Holds |
|---|---|
| `workspaces[].lifecycle` | the workspace's [state](#states), read after that pass |
| `workspaces[].prs[]` | one per PR file: `repo` (its worktree dir), `url`, `status`, `release` (the tag that shipped it, or null) |
| `readyToClose` | lifecycle `shipped` or `abandoned` and no Claude turn working. Listed whether or not the transcript moved, and never also in `candidates`. A workspace the label filter dropped is not listed. |
| `workspaces[].paused` | true while the workspace is [paused](#pause-and-resume). A paused workspace is never in `candidates` or `readyToClose`. |

The skill asks the person before `werkmeister workspace close` ([Close-out](#close-out)).

## Containers after a PR

A workspace's feature containers stop (SW-39) at these points. Stopping keeps the containers, the slot and the volumes, and `werkmeister feature up` brings them back. Shared infra is never stopped.

- `werkmeister pr open`: once a pass opens a PR and nothing in it failed. If any file failed its gate or push, the containers stay up so the session can fix it. A session woken for a CI fix runs `werkmeister feature up` before it re-gates.
- `werkmeister pr status`: when a pass records a PR as merged or shipped.
- The idle reaper: `werkmeister internal reap <minutes> [feature]` stops each feature that nothing has used for that many minutes. Without `[feature]` it covers every workspace. Something counts as use when:
  - a Claude session in the workspace is busy, or became idle less than N minutes ago (an open session that has sat idle longer does not keep the containers);
  - a container started less than N minutes ago;
  - the gate ran a `docker exec` less than N minutes ago (it touches `.werkmeister/last-exec`).

Every PR callback pass (the werkmeister mod's 10-minute timer and `werkmeister pr watch`) ends with one reaper pass, using N from `overrides.idle_stop_minutes` in `~/.werkmeister/config.yaml`. The default is 30, and `0` turns the reaper off. The pass takes its own lock, `~/.werkmeister/idle-stop.lock`.

A `docker exec` typed by hand in a terminal outside Claude is not seen.

`auto_stop` (a SessionEnd hook, `werkmeister internal session-end`) is on by default for `autonomous` workspaces. Set `auto_stop: false` in `.werkmeister/workspace.yml` to turn it off.

## Pause and resume

`⏸ Pause` on a card (or `werkmeister feature pause`, the `pause` MCP tool) takes a workspace's load off the host without losing its place (SW-70):

- It writes `.werkmeister/paused.json`: when, the containers that were running, and whether the agent was mid-turn.
- While that file exists, the agent-state hook ends the session's turn at its next tool call and blocks new prompts, from the person or from claude-send, PR callbacks and check-in. A tool call already running finishes first.
- It then runs `docker pause` on each of those containers, `<feature>-werkmeister-install` included. CPU is freed at once; memory is kept.

`▶ Resume` (`werkmeister feature resume`, `resume`) unpauses exactly the recorded containers, starts any that were stopped meanwhile (■ Stop or the idle reaper), and deletes the record. When Pause cut a working turn it also tells the session `Workspace resumed by the person. Continue where you left off.`:

| Session | How it continues |
|---|---|
| no live `claude` process (headless runs) | sent through claude-send |
| a live Desktop session | the Workspaces pane sends it within one poll |
| a live terminal or VS Code session | not sent; say "continue" there |

`up` and `restart` refuse while a workspace is paused. `stop` keeps the pause. `down` ends it.

## Issue status

The workspace's issue (`issue_id` in `workspace.yml`) moves by itself as the work does (SW-27). Each move happens at one lifecycle point and posts a short comment naming its trigger.

| Lifecycle point | Point | Jira (default) | GitHub (default) | Comment |
|---|---|---|---|---|
| Workspace created | — | no change | no change | — |
| First stage or phase starts: `werkmeister issue start`, run by ICM's first stage contract and JIT's `w9r-research` | `in_progress` | `In Progress` | label `status: in progress` | `Work started: stage 01_research in workspace <name>.` |
| `werkmeister pr open` | `in_review` | `In Review` | label `status: in review` | `PR opened: <url>` |
| A review asks for changes (`pr status`: `reviewDecision` or a latest review `CHANGES_REQUESTED`) | `in_progress` (back) | `In Progress` | label `status: in progress` | `Changes requested: <url>` |
| The changes-requested review clears while the PR is open | `in_review` | `In Review` | label `status: in review` | `Back in review: <url>` |
| PR closed without merging, and no other PR open | `in_progress` (back) | `In Progress` | label `status: in progress` | `PR closed without merging: <url>` |
| Every PR merged | `merged` | no change | no change | `Merged: <url>` |
| Shipped: every PR settled, one shipped (release tag contains the merge, or merged where `ship: merge`) | `done` | `Done` | close as completed | `Shipped: <release> — <url>` |
| `werkmeister pr open` for a follow-up after the issue is Done | — | no change | no change | `Follow-up PR opened: <url>` |
| `werkmeister workspace close` | `done` if not already | `Done` | close if still open | `Shipped: …` |
| `werkmeister workspace abandon "<reason>"` | `abandoned` | no status, comment only | close as not planned | `Abandoned: <reason>` |
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

A workspace in a project (`project:` in its `workspace.yml`, see the users guide § Projects) uses that project's `issue_statuses` instead, with the same keys; a key it leaves out takes its tracker's default, not this map's.

A key left out takes its default (table above). The flat keys `issue_progress_status`, `issue_review_status` and `issue_done_status` set `in_progress`, `in_review` and `done` when the map doesn't name them. On GitHub, `closed` / `done` / `completed` closes the issue as completed, `not planned` closes it as not planned, and anything else is a label.

**Rules.**

- **Forward only.** The issue's position comes from Jira's status category (`new` / `indeterminate` / `done`) and status name, or GitHub's open/closed state and `status:` label: new < in progress < in review < merged < done. A move applies only when it is ahead of that, apart from the two backward moves to `in_progress` above, which never leave done. Re-running init, a stage or `pr open` never drags an issue back. An issue that can't be read is not moved: the read is tried twice, then the warning line gives each failure (Jira's HTTP status, a network error, the MCP fallback, `gh`'s error) and the `werkmeister issue update <ref> --status … --comment …` command that makes the move by hand (SW-109).
- **One status label on GitHub.** Adding a `status:` label removes the issue's other `status:` labels, and creates the label if the repo lacks it.
- **Refusals warn.** No transition, no credentials, a status missing from the workflow: the move prints a warning naming the configured status and, for Jira, the transitions available, and the stage, PR open or close-out carries on.

## The PR guard

Every workspace's `.claude/settings.json` gets one managed PreToolUse hook, `werkmeister internal pr-guard`, with matcher `Bash|mcp__.*create_pull_request`. It is installed by `werkmeister feature up` / `init-workspace` for both strategies.

- Inside a workspace (any folder under one holding `.werkmeister/workspace.yml`), it denies `gh pr create` in Bash and the GitHub MCP's `create_pull_request`. The deny message points to `werkmeister pr open`.
- It matches a real invocation: `gh pr create` at the start of a statement (after `;`, `&&`, `|`, `(`, `$(`, a newline, env assignments or `env`/`command`/`exec`). The phrase inside quotes, a heredoc body or a grep pattern is allowed, so a `gh issue create` whose body quotes it goes through. A call hidden in a `bash -c "…"` or `eval` string isn't inspected either; the guard steers skills, it isn't a security boundary.
- This is what stops `/create-pr`, `superpowers:finishing-a-development-branch` or a raw `gh` call from opening a PR on the wrong repo or skipping the gate.
- `werkmeister pr open` runs `gh` itself, not through the Bash tool, so the guard never sees it.
- The `werkmeister:workspace-pr` skill and the `w9r-pr` skill steer toward the right path before the guard has to fire.

## Close-out

`werkmeister workspace close` is the only way to end a workspace. A post-mortem comes first; then it has two outcomes.

### Post-mortem

Lessons found mid-run (SW-104's CI failure on a typecheck the listed test commands never ran, SW-107) are lost with the workspace unless someone asks for them on purpose. So every close-out, shipped or abandoned, needs `postmortem.md` at the workspace root. The werkmeister `postmortem` skill writes it, and every route to close-out points there first (the ICM `CLAUDE.md` row and propose/spike checks, `pr-rules.md` rule 7 for ICM and JIT, `w9r-pr`, `workspace-pr`).

1. **Gather** the run's problems: failed checks, Auto-fix commits and change-requesting reviews on each PR file's `url`; issues filed from the workspace (their bodies name it); deviations and FAIL rows in stage outputs or JIT notes; gate failures and the person's corrections in the session transcripts.
2. **Agree** a change per problem: the agent proposes what could have been done differently, and the person accepts, edits or rejects it.
3. **Record** one row per problem: problem, source, cause, agreed change, action. A run with no problems records `Problems: none` and asks nothing.
4. **Act** on each accepted change, and name it in the row. Rank the actions: pick the highest one that makes the lesson reach every installation of werkmeister.
   1. **Shipped change, through an SW issue** (bug, feature or task): a code, skill or generated-text change. A change to `_shared/` or another generated file belongs here too, since the workspace's copy is regenerated and removed at close-out.
   2. **Standards edit** in the standards tree.
   3. **Memory entry, only for one person's own preferences,** such as their PR rules. It lives in Claude Code's auto-memory on one machine (`~/.claude/projects/<project>/memory/`), in no repo, and never ships with werkmeister, so no other developer or machine sees it. Never use it for a lesson about how werkmeister works.

   **Already enforced by `<check>`** (for example `name:check`) is also an action when a shipped check already catches the problem: confirm it does, name the check, and file nothing.
5. **Commit and push** `postmortem.md` on the record branch. The handoff also stages it by name, as it does `closeout.md`.

Without `postmortem.md`, close-out refuses before it changes anything: an unshipped workspace hears the ship refusal first, and with `--abandon` the PR files stay as they were. `--skip-postmortem "<reason>"` (MCP `skip_postmortem`) closes out without one, only when the person says to, and the reason goes in `closeout.md`. A retry of a `closed-out` workspace isn't checked again. The pane's and VS Code's buttons have no skip: they show the refusal, which says to ask Claude to close out.

**Shipped.** Without `--abandon`, it refuses unless the workspace is `shipped` or `abandoned`. A `spike` with no PR files is also allowed, and so is `closed-out` (a `closeout.md` exists but the removal failed), which retries. Then, in order:

1. **Issue.** The safety net: if the workspace has one and it isn't already done (shipping normally moved it), move it to `done` ([Issue status](#issue-status)). The comment names the release and PR. A tracker refusal is a warning in the output and in `closeout.md`; close-out goes on.
2. **Record.** Write `closeout.md`: one row per PR (repo, URL, status, merge SHA, release, reason), the issue line, and `Post-mortem: postmortem.md` (or `Post-mortem skipped: <reason>`).
3. **Remove.** `removeWorkspace`, the internal step: commit tracked changes and push every branch (the record branch now carries `closeout.md`), `werkmeister feature down`, reload the proxy, delete the directory, prune the worktrees. If any push fails, nothing is deleted. Untracked files never go on a branch: they are saved to `handoff/<workspace>/<repo>.tgz` in the werkmeister home, and the output lists them with each handoff commit's `--stat`.
4. **Branches.** Delete each merged code branch locally, and on origin if it is still there (GitHub's "delete branch on merge" may have done it already). An `adopted` PR's branch was never the workspace's, so it is kept. The record branch is kept.

**Abandoned.** `werkmeister workspace abandon "<reason>" <name>` ends a workspace whose work won't ship. The reason is required.

1. Every unsettled PR file becomes `abandoned` with the reason.
2. The issue gets a comment with the reason and moves to `abandoned` when one is configured (GitHub: closed as not planned). A refusal is a warning.
3. `closeout.md` records the reason and the post-mortem line.
4. Remove, as above, except that a code branch with no commits of its own is not pushed (it would hold only the handoff commit). Its handoff commit is saved as `handoff/<workspace>/<repo>.patch` instead, so no work is lost.
5. Every branch is kept.

The `abandoned` PR status is the record of this, not a second way in. A workspace whose PR files are already all `abandoned` closes out the same way without the flag.

### Sessions

The workspace's Claude sessions are cleaned up as part of close-out:

- **Desktop sessions.** The pane and the `close-out` MCP tool (through the werkmeister plugin) call `archive_session` on every desktop session whose cwd is in the workspace. The desktop app may refuse some, such as a pinned session, the one on screen, or an archive you declined outside auto mode. Each refusal is reported as "left open"; it doesn't fail the close-out. The CLI and VS Code can't reach the app, so they tell you to archive these from the sidebar.
- **Terminal sessions.** `claude` running in a terminal can't be archived from outside. Every surface lists those still open in the workspace (`terminal session: pid … on ttys… in <dir> — /exit it`) so you can exit them.

## Spikes

A spike (`01_questions`, `02_findings`) has no propose stage. Its PR files, when it has any, live in its last stage's output: `stages/02_findings/output/pr-<repo>.md`, and its `_shared/pr-rules.md` says so.

- **No repo deliverable.** No PR file. When `findings.md` is recorded where it is needed (the next workspace's brief, or the issue), `werkmeister workspace close` removes the workspace.
- **A repo deliverable** (e.g. a write-up in `docs/research/` "opened as a PR"). The findings stage commits it on the code worktree's branch and writes `pr-<repo>.md` at `status: draft`, with an acceptance table and `skip_exercise: <reason>` when there is nothing to exercise. The person sets `status: approved`, `werkmeister pr open` runs the gate and opens it, and close-out follows the normal PR path: it waits for the PR to ship. `werkmeister pr adopt` writes the file there too.
