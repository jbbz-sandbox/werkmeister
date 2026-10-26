---
"werkmeister": patch
---

SW-98: the CLI README and `main.ts` header no longer say Werkmeister runs "up to 12" features. Twelve is the default for `feature_slots.count` in `ports.yaml`, not a limit. How many features you can run at once depends on how many services each one runs locally and how much RAM you have.
