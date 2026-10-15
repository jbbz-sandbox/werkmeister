# Workspace lifecycle: from first commit to close-out

One process for every workspace, whichever context strategy (`icm` or `jit`) it uses and whichever skill or command was asked to "make a PR". Issue: jbbz-sandbox/sandbox#133 (absorbs #129).

## Words

Each term means one thing here.

| Term | Meaning |
|---|---|
| **Test** | run each touched service's registry `test:` command; the exit code decides |
| **Exercise** | observe the change in the workspace's running containers; PASS/FAIL per check |
| **Gate** | every pre-Open check below passes |
| **Approve** | the person sets a PR file to `status: approved` |
| **Open** | `sandbox pr open` creates the PR in the code repo |
| **Merge** | the person merges the PR |
| **Ship** | the merge is part of a release — the work is done here |
| **Verify** | checking the change in production. Defined, not built. |
| **Close out** | `sandbox close-out`: record, close the issue, remove the workspace, delete merged branches |

## States

```
working → ready → pr-open → merged → shipped → closed-out
                     ↘──────── abandoned ────────↗
```

The state is read from the PR files alone (`lifecycleOf` in `packages/sandbox-core/pr_lifecycle.ts`), so the workspaces pane shows it without a network call.

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
4. **Only `sandbox pr open` opens PRs.** A PreToolUse hook enforces this.
5. **Auto-fix is always on.** Right after `sandbox pr open`, in the Claude desktop app: bind the PR to this session (`ccd_pr` `get_status`; `bind_pr` with the PR's URL if it isn't bound), then turn on Auto-fix with `ccd_pr` `set_monitor` (`auto_fix: true`, `address_comments: true`, the PR's `url`). Don't ask first. Never turn on auto-merge.
6. **Merge is the person's act.** Tooling never merges.
7. **Close out only once every PR file is `shipped`, `closed` or `abandoned`.**

Each workspace gets these as `_shared/pr-rules.md` (ICM) or `.sandbox/pr-rules.md` (JIT), routed from its `CLAUDE.md`.

## PR files

One per code repo touched, named `pr-<repo>.md`, where `<repo>` is the code worktree's directory name.

- ICM: `stages/NN_propose/output/`. Workspaces generated before the rename use `NN_ship/`.
- JIT: `.sandbox/notes/`. Not a note: notes are named `NNN-*`.

```markdown
---
repo: jbbz-sandbox/sandbox     # the code repo on GitHub; never the workspace repo
branch: jayboyer/sandbox-133-workspace-pr-lifecycle
base: main
status: draft                  # draft | approved | open | merged | shipped | closed | abandoned
url:                           # written by sandbox pr open
merge_sha:                     # written by sandbox pr status
release:                       # the release tag that shipped it, written by sandbox pr status
reason:                        # required for closed / abandoned
skip_tests: {}                 # <service>: <reason> — for a service with no test command or no running container
skip_release:                  # <reason> — skips the gate's release check; a ship: tag repo still waits for its release tag
---
# feat(cli): owner/repo#133 Workspace PR lifecycle
<body: summary, test and exercise results, acceptance table, Fixes owner/repo#133>
```

The first `#` heading is the PR title and the rest is the body. The person sets `draft → approved`; tooling writes every other status and never infers `approved`.

## The gate

`sandbox pr gate [repo]` runs the checks and changes nothing. `sandbox pr open` runs them again before opening.

| Check | Passes when |
|---|---|
| stages | ICM: every stage before propose has output. JIT: no open decision notes. |
| acceptance | the PR body has a `PASS` table cell and no `FAIL` cell |
| clean | `git status --porcelain` in the code worktree is empty |
| test `<svc>` | the registry command for each touched service exits 0. It runs with `docker exec` in the service's container, because the worktree is mounted at `/app` with its `node_modules`. A service with no command, or with no running container for its repo, fails unless `skip_tests` names it with a reason. |
| exercise | `exercise.md` (ICM: any stage output; JIT: `.sandbox/notes/`) has a `PASS` cell and no `FAIL` |
| baseline `<svc>` | the touched local service's container is running; for `api`/`web` services, its `health_endpoint` also answers below 400 |
| release | for a `ship: tag` repo with a `release_check`, that command exits 0, unless `skip_release` gives a reason. `skip_release` affects only this check; `sandbox pr status` still waits for the release tag. |
| approved | `status: approved` |

**Touched services** come from `git diff --name-only origin/<base>...HEAD`. Each file maps to a service through the registry's `repos.<repo>.path_mappings`, by longest prefix. A file under no mapping marks every service in the repo as touched.

The test commands also appear in `.sandbox/sandbox-context.md` under "Test commands".

## Ship detection (registry `repo:`)

A repo's registry fragment (`<repo>/.sandbox/services.yaml`) says when its merges count as shipped:

```yaml
repo:
  ship: tag                                   # merge (default) | tag
  release_tag: "@jbbz-sandbox/sandbox-cli@*"  # glob for git tag --list; required for ship: tag
  release_check: npx changeset status --since=origin/main
```

`sandbox registry sync` merges this into `repos.<repo>` of `~/.sandbox/services.yaml`.

- With `ship: merge`, a merged PR is shipped as soon as it merges.
- With `ship: tag`, it is shipped once a tag matching `release_tag` contains its merge commit (`git tag --contains`).
- `release_check` stops a PR that would never reach a release. For changesets, a branch that changes a package without a changeset fails it.

## Commands

| Command | Does |
|---|---|
| `sandbox pr gate [repo]` | run the gate, change nothing |
| `sandbox pr open [repo]` | for each `approved` PR file: gate, push the branch, reuse or create the PR, write `status: open` and `url`, move the issue to "In Development" (on GitHub, add an `In Development` label, created if the repo lacks it), commit and push the PR file on the record branch |
| `sandbox pr status` | for `open` files, read `gh pr view` and write `merged` + `merge_sha` or `closed`. For `merged` files, write `shipped` (+ `release`) per the registry. Commits and pushes the changed PR files on the record branch. |
| `sandbox close-out [name]` | close out (below) |
| `sandbox remove-workspace <name> [--abandon "<reason>"]` | remove; refuses unshipped work unless abandoning |

The workspaces pane shows the state on each card. It offers **↻ PRs** (`sandbox pr status`) while a PR is open or merged, and **✓ Close out** once shipped, which asks twice. The sandbox-workspace MCP server has the same actions as `workspace-pr`, `close-out` and `remove-workspace` with `abandon`.

## The PR guard

Every workspace's `.claude/settings.json` gets one managed PreToolUse hook, `sandbox hooks pr-guard`, with matcher `Bash|mcp__.*create_pull_request`. It is installed by `sandbox up` / `init-workspace` for both strategies.

- Inside a workspace (any folder under one holding `.sandbox/workspace.yml`), it denies `gh pr create` in Bash and the GitHub MCP's `create_pull_request`. The deny message points to `sandbox pr open`.
- This is what stops `/create-pr`, `superpowers:finishing-a-development-branch` or a raw `gh` call from opening a PR on the wrong repo or skipping the gate.
- `sandbox pr open` runs `gh` itself, not through the Bash tool, so the guard never sees it.
- The `sandbox-tools:workspace-pr` skill and the `sb-pr` skill steer toward the right path before the guard has to fire.

## Close-out

`sandbox close-out` refuses unless the workspace is `shipped` or `abandoned`. A `spike` with no PR files is also allowed. Then, in order:

1. **Issue.** If the workspace has one and it isn't already done, move it to the done status: `overrides.issue_done_status` in `~/.sandbox/config.yaml`, else `closed` (GitHub) or `Done` (Jira). The comment names the release and PR. A tracker refusal stops close-out before anything is removed.
2. **Record.** Write `closeout.md`: one row per PR (repo, URL, status, merge SHA, release, reason) plus the issue line.
3. **Remove.** `removeWorkspace`: commit and push every branch (the record branch now carries `closeout.md`), `sandbox down`, reload the proxy, delete the directory, prune the worktrees.
4. **Branches.** Delete each merged code branch locally, and on origin if it is still there (GitHub's "delete branch on merge" may have done it already). The record branch is kept.

## Abandoning

`removeWorkspace` refuses while a PR file is `open`, or while a code branch has commits not on its base and no merged PR file. With `--abandon "<reason>"` it goes ahead:

- it marks every unsettled PR file `abandoned` with the reason;
- it writes `closeout.md`;
- it still pushes every branch, so no work is lost.

## Spikes

A spike has no propose stage and no PR files. When `findings.md` is recorded where it is needed (the next workspace's brief, or the issue), `sandbox close-out` removes the workspace.
