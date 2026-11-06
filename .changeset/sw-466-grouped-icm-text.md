---
"werkmeister-core": patch
"werkmeister": patch
---

SW-466, SW-497, SW-467, SW-479, SW-465, SW-468: grouped ICM contracts tell the agent to regenerate a changed generated snapshot (e.g. `strategy-jit.snapshot.json`) inside each ticket's commit, and that commit order across tickets is free (the grouped 02_spec no longer fixes it). The grouped refactor 01_scope lists its steps under each ticket key. Every build stage's review brief rates a finding that can restart or write the host daemon, the real `~/.werkmeister` or another workspace as Must fix. `--group` keys are normalised by the tracker's `parseRef`, and the lead's own key is dropped (a lead-only list writes `group: []`). The `--work-type` help says it selects the ICM stages, and the `workspace init --group` help says "one PR, one commit per ticket".
