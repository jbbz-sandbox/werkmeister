---
"werkmeister-core": patch
"werkmeister": patch
---

SW-1225: rule 5 of the generated `pr-rules.md` and the `pr watch` conflict wake now say to run `werkmeister pr push <repo>` as a plain command from the workspace root, with no `cd … &&`, pipe or redirect, and why: a Claude Code allow rule matches only when every segment of the line does, so any extra segment sends the line to auto mode's classifier, which can refuse it as a force-push.
