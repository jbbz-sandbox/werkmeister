---
"werkmeister-core": minor
"werkmeister": minor
---

SW-268: `werkmeister machine config` (bare or `--show`) now also prints the whole `config.yaml` as YAML with secrets masked: any value under a key named like `token`, `secret`, `password`, `credential`, `api_key`, `private_key`, `access_key` or `auth` (so `jira.api_token`) prints as `<redacted>`, and empty values stay empty. The autonomous run limit that says not to read the real `~/.werkmeister` now points agents at this view.
