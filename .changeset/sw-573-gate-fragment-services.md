---
"werkmeister": patch
"werkmeister-core": patch
---

`werkmeister pr gate` and `pr open` no longer test every service when the diff touches the repo's own `.werkmeister/services.yaml`. The gate compares the branch's rendered fragment with the one on its base (both through the same registry merge) and touches only the services whose entries differ, so a changed `test:` runs that one service. The `tests` row says so (`fragment: .werkmeister/services.yaml changes <svc>`). A `repo:` key change, or a change to one of the repo's own `setup_services`, still tests every service, and so does a `path_mappings` / `no_service_paths` change that maps a file of the diff differently.
