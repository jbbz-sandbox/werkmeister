---
"werkmeister": patch
"werkmeister-core": patch
---

SW-1160: the bugfix `01_reproduce` stage contract asks, when the fix changes a shared writer or adds persisted state, for each caller that writes another workspace's files or the machine's (a migrate or sweep across workspaces, a daemon, close-out), how the change reaches each, and a test per such caller.
