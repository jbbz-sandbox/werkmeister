---
"werkmeister": patch
---

`pr watch` now reaches a session that is still open. A wake it holds for a busy terminal session (a conflict, a failed check, a review, a merge) is claimed and handed to that session's hooks: it arrives as context on the session's next prompt or tool call, or blocks its next Stop. It is never sent headless as well, and the workspace card stays `needs-you` until the session gets it (SW-418).
