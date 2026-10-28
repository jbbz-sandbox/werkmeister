---
"werkmeister-core": patch
"werkmeister": patch
---

SW-145: `werkmeister pr open` prints a `<pr-created>URL</pr-created>` line for each PR it opens, so the Claude desktop app counts the session as the opener and `set_monitor` with `auto_fix: true` is allowed. Rule 5 in the generated `pr-rules.md` now says: when `set_monitor` is refused, don't retry; ask the person to turn Auto-fix on from the PR bar, and don't rely on `get_status` to confirm it.
