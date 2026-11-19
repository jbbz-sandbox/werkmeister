---
"werkmeister": minor
---

SW-828: the six `with-temp-home … node --test*` ask rules are now opt-in (`workspace_ask_rules: true` in `~/.werkmeister/config.yaml`), since they prompted on every core test run even in auto mode. Workspaces drop the recorded ones on their next `feature up` or `machine migrate`. New ask rules cover `docker exec * <ws>/.werkmeister/bin/with-fixture-workspace [--no-wait] --exec-runs*`, which ran with no prompt.
