---
"werkmeister": patch
---

`with-fixture-workspace --config <file>` adds a YAML file's `budget` section (e.g. `budget.host_load`) to the fixture's config.yaml, so a fixture run can exercise budget and load paths; any other key is refused (SW-670).
