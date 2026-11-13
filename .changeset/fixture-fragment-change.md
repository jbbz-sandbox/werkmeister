---
"werkmeister": patch
---

`with-fixture-workspace --gate --fragment-change <file>` commits a registry-fragment-only diff, so a fixture `pr gate` shows the `fragment: .werkmeister/services.yaml changes <svc>` row and runs only that service; `--change <path>` names the file `--gate` changes instead of the fixture's default lib file (SW-664).
