---
"werkmeister": patch
---

SW-568: `pr-rules.md` rule 3 gives the `pr open` log redirect with the absolute workspace path, so a shell cwd that drifted into a code worktree cannot write `pr-open.log` there as an untracked file. The existing `werkmeister pr` allow rule still matches. New workspaces get the text.
