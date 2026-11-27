---
"werkmeister": patch
---

SW-927: `werkmeister workspace new` checks every code repo before it creates the workspace root: the repo must exist, be a git repo, have an `origin` remote and resolve a base branch. A repo with no `origin` now fails up front with a message that names it and gives `git remote add origin <url>` and the push, instead of failing in `workspace init` with "Could not determine default branch" and leaving a half-made workspace.
