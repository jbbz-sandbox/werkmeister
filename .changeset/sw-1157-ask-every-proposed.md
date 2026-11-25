---
"werkmeister": patch
"werkmeister-core": patch
---

SW-1157: every ICM human check tells the agent, before it ends the turn, to `grep -l "status: proposed" stages/*/output/*.md`, ask every hit, and ask again when the question call errors or is interrupted. The werkmeister Claude Code plugin adds a Stop guard. In a workspace with a stage output still at `status: proposed` and no answered AskUserQuestion since the last prompt, it blocks the stop once and names the files.
