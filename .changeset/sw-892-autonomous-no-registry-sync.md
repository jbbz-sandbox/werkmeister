---
"werkmeister": patch
---

In an autonomous workspace, `werkmeister pr status` no longer pulls the source checkout and syncs the machine registry for a merged PR under `sync_on_merge: auto`. It prints the `registry sync needed` notice as `warn` does, since the agent can edit the PR file that asks for the sync; run `werkmeister registry sync` yourself (SW-892).
