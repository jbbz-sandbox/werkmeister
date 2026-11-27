---
"werkmeister-core": minor
---

`workspace.create` and `workspace.init` metrics lines record the run's `work_type`, and `metrics rebuild` backfills it from each record branch's `workspace.yml` (`unknown` when unreadable). The `metrics` and `metrics-trends` tools take a `work_type` filter, the report adds `byWorkType` (cycle and lead time, column p50/p90, waits and cost per type), and a flow card is past p90 against its own type's column p90, or the pooled one below 5 runs. The dashboard's Flow and Metrics tabs get a work type selector, the cycle-time scatter is coloured by type, and the Flow tab adds a "where the time goes" chart of median minutes per column, one bar per work type (SW-1212).
