---
"werkmeister": patch
---

SW-1156 follow-up: when a resumed workspace's Claude session can't be found (for example, a workspace folder outside `workspaces_root`), `werkmeister feature resume` no longer fails after the containers are already unpaused. "Continue" waits for the session, as it does for a session with no recorded mode.
