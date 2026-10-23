---
"werkmeister": patch
---

PR rules: squash is the default merge; a PR whose commit SHAs must survive (e.g. a `.git-blame-ignore-revs` entry) asks for a merge commit at the top of its body. `pr open` warns when the branch adds a blame-ignore SHA.
