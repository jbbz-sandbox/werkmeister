---
"werkmeister": patch
---

SW-565: `pr-rules.md` rule 5 and the `workspace-pr` skill say to take the force-push lease's `<old sha>` from `git rev-parse origin/<branch>` after a fetch and paste it verbatim, never shortened or retyped, for a manual rebase with no wake message to copy from. New workspaces get the text.
