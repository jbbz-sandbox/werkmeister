---
"werkmeister": patch
---

SW-1021: the generated PR rules (rule 3) and the ICM test and gate steps now tell the agent to give the person a background run's absolute log path and a `! tail -f <log>` line in the reply that starts it, and never to run `tail -f` itself. Each record commit after a gate run stages `.werkmeister/logs/gate-*.log` by name, so the per-row gate logs reach the record with `gate-run.log`.
