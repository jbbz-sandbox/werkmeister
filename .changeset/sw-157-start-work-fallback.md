---
"werkmeister-core": patch
---

▶ Start work no longer dead-ends in auto mode (SW-157): when the pane's own `start_session` call is refused, it drafts a message in the hosting session's prompt box asking its model to make the same call with the same arguments, and the person presses Enter to send it. Run titles from `startArgs()` / `werkmeister start-args` are cut at a word with a trailing `…` instead of mid-word.
