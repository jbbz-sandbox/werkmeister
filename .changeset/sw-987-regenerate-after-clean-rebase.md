---
"werkmeister": patch
"werkmeister-core": patch
---

When `werkmeister pr open`'s auto-rebase applies cleanly but both sides changed a file the repo marks `linguist-generated` in `.gitattributes` (a snapshot, a lockfile), the base row now fails and names it before the tests run, so the agent regenerates it instead of a stale line-merge failing the test row minutes later (SW-987). PR rule 5 says the same for a manual clean rebase. werkmeister marks its JIT snapshot, man pages, `docs/cli-reference.md` and `pnpm-lock.yaml`.
