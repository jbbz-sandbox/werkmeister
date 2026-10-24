---
"werkmeister": patch
---

`sandbox-install` installs again when a workspace is re-created under the same feature name on its kept `node-modules` volume (SW-85). Each package's own `node_modules` lives in the worktree, not the volume, so the SW-33 skip now needs a second copy of its stamp in the worktree (`.turbo/.sandbox-install-hash`) to match as well. A re-created worktree, or a dropped volume, reinstalls; the build no longer fails on missing per-package deps, and `down -v` is no longer needed first. With both intact and the lockfile unchanged the install is still skipped. Each existing workspace reinstalls once on its first up after this change.
