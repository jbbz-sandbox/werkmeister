---
"werkmeister": patch
---

SW-576: a CLI built from an uncommitted tree no longer prints the stale-build notice after an amend that commits exactly that tree. The build stamp also records the dirty tree's id (made in a temp index and object dir: the workspace container mounts the worktree's index read-only, and the build writes nothing to the shared git store), and the notice is silent when HEAD's tree has that id, so `bins.test.ts` stops failing after such an amend.
