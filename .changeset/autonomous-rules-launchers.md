---
"werkmeister": patch
---

Autonomous workspaces now allow and deny `werkmeister …` and `w9r …` commands the same as `sandbox …`. The rules were written only for the deprecated `sandbox` launcher, and a permission rule is a literal prefix, so a run calling `werkmeister up` stalled waiting for approval while `werkmeister down` slipped past the deny list. The deny list also drops the removed `remove-workspace` MCP tool. Rerun `init-workspace` (or `werkmeister up`) in an autonomous workspace to pick up the new rules.
