---
"werkmeister": patch
---

`pr open`'s record commit force-adds the paths it names, so a workspace created before SW-401 (whose `.gitignore` still ignores `gate-*.log`) gets its "record opened PR(s)" commit with the PR file and logs instead of failing on the ignored pathspec (SW-407).
