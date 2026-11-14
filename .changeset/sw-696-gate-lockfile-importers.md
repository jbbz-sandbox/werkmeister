---
"werkmeister": patch
"werkmeister-core": patch
---

`werkmeister pr gate` and `pr open` no longer test every service when the diff touches `pnpm-lock.yaml`. The gate compares the worktree's lockfile with the one at the diff's base and touches only the services at the `importers:` entries that differ, mapped through `path_mappings` like a file under that importer. The `tests` row says so (`lockfile: pnpm-lock.yaml changes importers <path> → <svc>`). A change to the root importer `.`, to an importer no mapping covers, to an existing `packages:`/`snapshots:` entry, or to a top-level setting (`overrides`, `settings`, …) still tests every service, and so does a lockfile with no copy on the base.

`with-fixture-workspace` takes `--change-base <file>` and `--change-branch <file>` (with `--change`), which give the changed file real text on main and on the branch, e.g. two lockfile copies.
