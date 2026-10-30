---
"werkmeister": patch
---

A workspace description containing `'`, `"`, `$`, `#` or `\` no longer breaks docker compose: `init-workspace` writes such values to `.env` in double quotes, and re-runs read them back unchanged (SW-207).
