---
"werkmeister-core": patch
---

`machine setup` seeds `~/.werkmeister/model-pricing.yaml` with no model rows (SW-836). The built-in rates price every model, so a later price change reaches the machine; a row you add still overrides the built-in rate for that model. A file seeded earlier is never rewritten and its rows still override the built-ins: to pick up the SW-773 repricing (Claude Opus 4.8, Sonnet 5), delete those rows from `~/.werkmeister/model-pricing.yaml`.
