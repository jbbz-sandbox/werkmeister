## Description

A one-shot move of the pre-rename machine folder to `~/.werkmeister`, repointing every file that carries the old path. Safe to re-run; it refuses while containers the move would break are running. Pull and rebuild the CLI before you migrate.

It also brings what an older CLI wrote up to the noun-group spellings (SW-186): each workspace's hooks, permission rules and `with-temp-home`, the stale pre-rename MCP token in `secrets.env`, and Claude Desktop's server args. A workspace whose `.env` still exports only `SANDBOX_FEATURE` is listed; run `werkmeister workspace init` there.

## Examples

```bash
werkmeister machine migrate --check
werkmeister machine migrate --workspaces
```
