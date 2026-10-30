## Description

**What it does:**

1. Identifies per-feature Docker volumes (node_modules, build caches) that belong to stopped features
2. Removes those orphaned volumes
3. Releases stale slot entries (features with no running containers or compose file)

With `--all`, it first stops all active features (equivalent to running `werkmeister down --volumes` for each), then cleans everything.

**When to use:**
- After extended development with many features started and stopped — volumes accumulate
- Before a fresh start: `werkmeister clean --all`
- To check what would be cleaned: `werkmeister clean --dry-run`
