---
"werkmeister": patch
---

The sandbox repo's containers now share one turbo build cache at `~/.sandbox/cache/turbo` (`TURBO_CACHE_DIR`), so a commit any workspace has built restores in about a second in every install and gate run. Before, the cache sat in the main checkout's `.turbo` and the install container missed it. `TURBO_CACHE_MAX_AGE=14d` bounds the cache, and installs build one at a time so concurrent writers can't collide. Run `werkmeister registry` to pick up the new settings. The old `~/repos/sandbox/.turbo` can be deleted by hand.
