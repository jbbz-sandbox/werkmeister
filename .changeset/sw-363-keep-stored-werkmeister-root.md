---
"werkmeister": patch
---

SW-363: a branch-built CLI run on the host (a test without `with-temp-home`, a worktree's `machine config` or `machine setup`) no longer writes its own worktree into `~/.werkmeister/config.yaml` and `env.sh` as `werkmeister_root`. The writers keep the stored value and warn unless the running checkout is the `werkmeister` on PATH; to move it by hand, edit `config.yaml` and run `werkmeister machine config --write`.
