---
"werkmeister-core": patch
---

SW-773: usage costs price the current models (Claude Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.2), so `usage.json` and the `workspace-usage` tool no longer show a null cost for every run. `~/.werkmeister/model-pricing.yaml` now overrides the built-in rates instead of replacing them, so a file seeded before a model shipped still prices it with no edit. A model with no rate is reported once instead of silently. The built-in and newly seeded rates for Claude Opus 4.8 and Sonnet 5 move to their published prices ($5/$25 and $2/$10). An existing `model-pricing.yaml` keeps its own older rows for those two models (15/75 and 3/15), and those still win. Delete those rows, or the whole file, to use the new rates.
