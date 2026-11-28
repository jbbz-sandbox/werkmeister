---
"werkmeister": patch
---

SW-946: `machine setup` and `machine migrate` run against a relocated `WERKMEISTER_CONFIG_FILE` leave launchd and the crontab alone: the PR watch schedule and the daemon agent are skipped ("WERKMEISTER_CONFIG_FILE is not the default home"), as under a temp HOME or the fixture.
