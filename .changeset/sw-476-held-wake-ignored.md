---
"werkmeister-core": patch
---

SW-476: a held `pr watch` wake (`.werkmeister/wake-nudge*`: the per-session file, a `.claimed` leftover, or the older `wake-nudge.json`) is git-ignored on the workspace record branch, so a record commit never takes it. `feature up` adds the rule to an older workspace and untracks one already committed.
