---
"werkmeister": patch
---

Before a run files a bug about a generated file (`.claude/settings.json`, `.werkmeister/*`, `compose.yml`, `.env`) that changed outside its own edits, the review step of every ICM code stage and the issues guide's "Bugs: new or existing?" tell it to compare the file with its record (`claude-permissions.json`), compare its mtime with the session's own activity, and ask the person through the question tool whether they edited it (SW-844).
