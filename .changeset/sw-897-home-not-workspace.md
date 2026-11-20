---
"werkmeister": patch
---

The edit gate's hook no longer treats your home folder as a workspace because `~/.werkmeister` is there: a session under `~` outside any workspace resolves no workspace (SW-897).
