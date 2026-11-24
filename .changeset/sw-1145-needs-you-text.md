---
"werkmeister": patch
---

SW-1145: an autonomous workspace whose session stops mid-build with no question now reads Needs you, with the reply's last paragraph shown as a guess, instead of Idle. An autonomous agent stops on its own only when it is blocked, so this catches an ask with no `?`, such as a `!` command for the person in the middle of a reply. Merged, released or abandoned workspaces, and non-autonomous ones, read as before. Every ICM stage contract also says a step only the person can take goes through the question tool.
