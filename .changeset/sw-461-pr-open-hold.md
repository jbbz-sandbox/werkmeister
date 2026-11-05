---
"werkmeister": minor
---

`pr open`: a `hold: <reason>` field in the PR file opens the PR as a draft, with `Don't merge until: <reason>` at the top of its body, so a PR that waits for a step outside the code can't be merged early. Run `gh pr ready <url>` once the step is done (SW-461).
