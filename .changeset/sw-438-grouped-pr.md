---
"werkmeister": minor
---

A workspace can mark itself as a grouped PR with `group: [<member keys>]` in `.werkmeister/workspace.yml`. Its ICM build stages then commit once per ticket and review the range `origin/main...HEAD`, and `propose` keeps the per-ticket commits, asks for rebase and merge, and closes each member after the release (SW-438). The same release: implement stages review before `pr gate --tests` (SW-430), the review brief asks what a newly pre-approved command can reach (SW-431), the first stage's brief rule names no werkmeister files (SW-414), and propose's lint step reads "when it has one" (SW-415).
