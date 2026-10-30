---
"werkmeister": patch
---

SW-196: `init-workspace` and `workspace` regenerate `~/.werkmeister/services.yaml` from the repo fragments first, so a fragment change merged to main reaches the next workspace's werkmeister-context.md without a manual `werkmeister registry sync`. A hand-written registry is left as is, with a warning.
