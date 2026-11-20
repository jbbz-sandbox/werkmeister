---
"werkmeister": patch
---

`werkmeister machine config <args>` and `werkmeister machine setup` keep every top-level section of `~/.werkmeister/config.yaml` they don't ask about, such as `budget:`, `models:` and `github_ingest:`. Before, both rebuilt the file from a fixed key list and dropped any other section (SW-852).
