---
"werkmeister": patch
---

SW-1134: removing a workspace (`werkmeister workspace close` or `abandon`) now deletes its local `<user>/<workspace>` branch, and any `<user>/<workspace>-*` follow-up branch, in each source clone once the handoff has pushed it, so closed workspaces no longer pile up local branches. Close-out still deletes a merged branch on origin.
