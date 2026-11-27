## Description

**What it does:**

1. Identifies per-feature Docker volumes (node_modules, build caches, sidecar data) that belong to stopped features: a volume counts only when the feature's own compose project created it, so another project's `myapp-pgdata` is never touched
2. Removes those orphaned volumes
3. Releases stale slot entries (features with no running containers or compose file)
4. Removes the host-load probe containers (`com.werkmeister.role=vm-load`) a killed `docker run` left Created or exited

With `--all`, it first stops all active features (equivalent to running `werkmeister feature down --volumes` for each), then cleans everything.

**When to use:**
- After extended development with many features started and stopped — volumes accumulate
- Before a fresh start: `werkmeister machine clean --all`
- To check what would be cleaned: `werkmeister machine clean --dry-run`
