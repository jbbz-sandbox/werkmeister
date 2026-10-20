---
"werkmeister-core": patch
---

SW-65: the `check-in` MCP tool reports each workspace's `lifecycle` and `prs` (repo, url, status, `release`), and names the shipped or abandoned workspaces with no Claude turn working as `readyToClose`. Before reporting, it ships merged PRs a release tag now contains, with the same rule and code as `werkmeister pr status` and no `gh` call.
