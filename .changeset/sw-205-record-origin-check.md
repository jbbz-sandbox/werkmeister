---
"werkmeister-core": patch
"werkmeister": patch
---

SW-205: workspace records no longer push to a stale repo. `werkmeister setup --check` now fails when `repos_root/sandbox-workspace`'s origin isn't `overrides.workspace_repo` (or the `<gh user>/sandbox-workspace` default), naming both URLs; SSH and HTTPS forms of the same owner/repo match. `werkmeister setup` asks before repointing origin to the configured HTTPS URL, keeps the old URL as a remote named after its owner, then fetches; non-interactive runs change nothing and print the commands. It never fetches a mismatched origin. `werkmeister workspace` refuses to create a record worktree until they match.
