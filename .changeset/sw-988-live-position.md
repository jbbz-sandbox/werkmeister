---
"werkmeister-core": patch
---

A waiting workspace's queue position is now its place in the queue at the moment it is shown, the same number `werkmeister budget status` prints (SW-988). The VS Code tree, the /workspaces pane, `status` and the capacity hook's texts all showed the number stored when `waiting.json` was written, so every preempted waiter kept the back-of-queue number it was given ("position 7" for six features at once).
