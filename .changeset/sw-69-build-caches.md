---
"werkmeister": minor
---

Build and package caches are registry data (SW-69). A `caches:` entry gives a cache's container path, the env that points the tool at it, the lockfiles that attach it and an age or prune rule; `turbo` and `pnpm-store` are built in, and a repo can add its own. `up` creates only the shared volumes a workspace mounts, `werkmeister status` lists each cache's size and age, and `werkmeister cache prune [name]` (`--reset`, `--dry-run`, `--force`) clears them. The turbo cache moves from `~/.sandbox/cache/turbo` to the shared `sandbox-turbo` volume.
