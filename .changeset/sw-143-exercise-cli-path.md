---
"werkmeister": patch
---

SW-143: every ICM exercise step (feature and refactor `implement`, bugfix/incident `exercise`) now spells out the library/CLI-only path: build, then run the built binary from a temp folder against a fixture workspace, seeded with `services.yaml`, `ports.yaml` and a `config.yaml` whose `paths.workspaces_root` holds it, through `with-temp-home` with `WERKMEISTER_CONFIG_FILE` pointing at that config. Write-capable commands run only against the fixture; only read-only ones (e.g. `werkmeister skills check`) may run from the real workspace. Existing workspaces pick it up on the next `werkmeister init-workspace`.
