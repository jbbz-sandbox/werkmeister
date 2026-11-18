---
"werkmeister-core": patch
---

The fixture's config.yaml sits at its temp HOME's `~/.werkmeister/config.yaml`, and `machine migrate` runs when `*_CONFIG_FILE` names that default path, so `with-fixture-workspace machine migrate` works (SW-581).
