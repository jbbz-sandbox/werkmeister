---
"werkmeister": minor
"werkmeister-core": minor
---

SW-717: `werkmeister pr push [repo]` force-pushes an open PR's rebased branch with `--force-with-lease` on `origin/<branch>`, so a session finishes rule 5's conflict fix without the person. It refuses anything but the workspace's own checked-out branch, a dirty tree, a merge from the base, or a lease origin no longer matches. ICM workspaces pre-approve it; rule 5 and the conflict wake message name it. SDK: `pushPrs`.
