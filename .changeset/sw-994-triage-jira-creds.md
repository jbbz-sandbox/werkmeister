---
"werkmeister": patch
---

SW-994: the triage scripts (`report.py`, `rank.py`, `apply.py`) take Jira credentials the way the CLI does: `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN` from the environment first, then the `jira:` block of config.yaml and the token in secrets.env, both beside `WERKMEISTER_CONFIG_FILE`. With none of them they exit naming both places, not with a traceback.
