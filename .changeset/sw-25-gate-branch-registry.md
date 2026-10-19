---
"werkmeister-core": patch
---

`sandbox pr gate` (and `pr open`) now tests a branch with its own `.sandbox/services.yaml` fragment: the gated repo's `test:` commands and path mappings come from the worktree, every other repo and the `services.local.yaml` overlay as `registry sync` builds them. A PR that renames packages and updates its own test filters can pass its gate without a machine-wide override, and the shared `~/.sandbox/services.yaml` is not touched (SW-25).
