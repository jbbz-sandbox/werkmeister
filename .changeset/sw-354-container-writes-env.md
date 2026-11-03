---
"werkmeister-core": patch
"werkmeister": patch
---

Machine config writes (`werkmeister machine config --write`, `machine setup`, `machine migrate`) refuse inside a workspace container with `INSIDE_CONTAINER`: the container's HOME is the host home and `~/.werkmeister` is bind-mounted, so a write there pinned the host's `werkmeister_root` and `env.sh` to the container's `/app/apps/cli` (SW-354). A config relocated with `WERKMEISTER_CONFIG_FILE` is still written. The `setup_run_pending` test, which did the writing from the PR gate's container, now stubs the writers.
