---
"werkmeister": patch
---

SW-945: the Jira API token lives in `~/.werkmeister/secrets.env` as `JIRA_API_TOKEN`, no longer as `jira.api_token` in config.yaml, which people and agents read to check a setting. A token left in config.yaml still works and moves to secrets.env the next time werkmeister writes the config; one already in secrets.env wins. `machine setup` writes a token typed at its prompt to secrets.env.
