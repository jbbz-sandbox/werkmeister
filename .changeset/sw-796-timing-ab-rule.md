---
"werkmeister": patch
"werkmeister-core": patch
---

SW-796: a CPU or wall-time number that a decision or acceptance criterion rests on now has to come from paired, alternating A/B runs (at least 3 each) through `with-temp-home` with its load wait on, never a single run or `--no-wait`, with every run's numbers and the host load recorded. The rule is in the feature research stage (step 3) and in every stage that writes `exercise.md`.
