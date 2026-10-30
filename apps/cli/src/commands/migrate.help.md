## Description

A one-shot move of the pre-rename machine folder to `~/.werkmeister`, repointing every file that carries the old path. Safe to re-run; it refuses while containers the move would break are running. Pull and rebuild the CLI before you migrate.

## Examples

```bash
werkmeister migrate --check
werkmeister migrate --workspaces
```
