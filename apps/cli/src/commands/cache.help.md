## Description

Applies each shared cache's rule from the registry's `caches:`: `max_age` deletes older entries, `prune` runs the tool's own command. `--reset` empties the cache instead. A cache that a running container mounts is skipped unless `--force`.

## Examples

```bash
werkmeister cache prune
werkmeister cache prune --dry-run
werkmeister cache prune --reset
```
