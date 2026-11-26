---
"werkmeister": minor
---

SW-272: push wakeups reach sessions opened in the Claude desktop app. After a GitHub event, the daemon's pass leaves a stamp in `~/.werkmeister/pr-push/`, and the werkmeister mod in a running desktop session runs that repo's pass within about 15 s instead of waiting for its 10-minute pass. Several desktop sessions run one pass per stamp between them.
