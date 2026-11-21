---
"werkmeister": minor
"werkmeister-core": minor
---

A metrics event log at `~/.werkmeister/metrics/events-YYYY-MM.jsonl` (SW-775): append-only, one JSON line per event, local only. The first events are `queue.wait`, written the first time a feature waits for capacity, and `queue.admit` with `waited_s`, written when that wait ends in an admit. Lines follow `docs/superpowers/specs/2026-11-15-metrics-events.schema.json`.
