---
"werkmeister": patch
---

SW-974: the install check (and the plugin's SessionStart `--fix`) reports a dev link off `main` as drift, naming the branch and its commits not on `origin/main`, or saying it is already there when squash-merged. It only warns: no fetch, no branch switch.
