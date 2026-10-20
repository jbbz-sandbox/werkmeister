---
"werkmeister-core": minor
---

`getWorkspaceStatuses()` returns every workspace-card field: ICM `stage`, JIT `phase`, `autonomous`, `autoStop` and `lastActivity`, next to the existing per-service health and `model`. `getWorkspacePRs()` returns `ci` (`pass` · `running` · `fail`) and `failingChecks` per PR from `statusCheckRollup`. New exports `icmStage()` and `ciOf()`; the pane now reads the stage from core (SW-47).
