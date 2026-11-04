---
"werkmeister": patch
---

The ICM propose stage runs the repo's lint command after adding the release entry and before committing, so a bad changeset fails there instead of at `werkmeister pr open` (SW-399).
