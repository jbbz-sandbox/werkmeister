---
"werkmeister-core": minor
"werkmeister": minor
---

`werkmeister pr status` (and the PR watch pass) now notices a merged PR that changes its repo's `.werkmeister/services.yaml` fragment. By default it prints `registry sync needed: <repo> fragment changed in <url>` and shows it on the workspace card. With `sync_on_merge: auto` in the fragment's `repo:` (or in `services.local.yaml` under `repos.<repo>`), it fast-forwards the clean source checkout, runs `registry sync`, prints what changed and names the running features to bring up again with `werkmeister feature up`.
