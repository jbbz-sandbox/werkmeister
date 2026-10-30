---
"werkmeister-core": patch
"werkmeister": patch
---

SW-194: `werkmeister pr gate` and `pr open` fail fast when a PR file's `repo:` is not the code worktree's `git remote get-url origin` (SSH and HTTPS forms, with or without `.git`). The `repo` row names the field and shows both values, where the mismatch used to surface as a `gh pr create` GraphQL error. The Stage 04 contract and PR rules now say to take `repo:` from that command.
