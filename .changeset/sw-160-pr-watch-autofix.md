---
"werkmeister-core": minor
"werkmeister": minor
---

SW-160: `werkmeister pr watch` is werkmeister's own auto-fix. While a PR is open, each pass wakes the session that opened it, in one message, when a check on the head commit fails (with the first error lines of `gh run view --job <id> --log-failed`), when a review or comment arrives (quoted), or when the PR conflicts with its base (with the base commits that moved). Each event is claimed once in the PR file (`notified_checks`, `notified_review`, `notified_conflict`). A terminal or VS Code session whose transcript changed in the last 5 minutes is held and woken on a later pass, so a headless turn never runs beside a live one. PR rule 5 no longer turns on the desktop app's Auto-fix (`ccd_pr set_monitor`), and `pr open` no longer prints the `<pr-created>` marker.
