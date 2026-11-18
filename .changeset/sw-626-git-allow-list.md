---
"werkmeister-core": patch
---

Autonomous workspaces no longer pre-approve `Bash(git:*)`. They get an allow-list of the subcommands a run uses (status, diff, log, show, add, commit, restore, branch, rev-parse, ls-files, merge-base, rev-list, switch, checkout, symbolic-ref, `worktree list`), bare or as `git -C <repo>` for the workspace's own repos only, plus exact `fetch`, `fetch origin`, `fetch origin main`, `remote -v`, `remote get-url origin` and `rebase origin/main`/`--continue`/`--abort`. `grep` (whose pager option git also takes as `-lO` or `--open`), `rebase -x`, `bisect run`, `submodule foreach`, `difftool`, `push`, `init`, `clone`, `stash` and `-C <another workspace>` now ask; `--output` and `--no-index` (which write and read any path) and Edit on any `.git/` are denied (SW-626).
