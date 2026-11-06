---
"werkmeister-core": patch
"werkmeister": patch
---

SW-510: a workspace's Claude settings no longer pre-approve `with-temp-home env WERKMEISTER_ROOT=* node --test:*` or its `--no-wait` twin, because `node --test <file>` runs any file, including one the agent just wrote. Both forms are now `ask` rules, and `machine migrate` moves them in existing workspaces. Tests run without a prompt through the registered test commands (`with-temp-home <test command>`), and the generated `werkmeister-context.md` now says so.
