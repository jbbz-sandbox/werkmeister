---
"werkmeister": patch
---

An autonomous workspace's `BRIEF.md` now has exactly one `## Run limits` section: a copy that the `starting_prompt` or description brings along is dropped, so only the canonical limits (`werkmeister feature up`/`feature stop`, `werkmeister infra proxy-reload`) remain and the brief no longer contradicts itself (SW-308).
