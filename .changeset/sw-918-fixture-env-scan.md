---
"werkmeister": patch
---

`with-fixture-workspace` also blanks the caller's `WERKMEISTER_BIN`, `WERKMEISTER_MODEL_PRICING_YAML`, `WERKMEISTER_SERVICES_YAML`, `WERKMEISTER_PORTS_YAML`, `WERKMEISTER_WORKSPACES_ROOT`, `CHROME_BIN`, `VSCODE_BIN` and `CLAUDE_PROJECT_DIR`, so a fixture step never runs the caller's werkmeister or reads its pricing table. A test now finds every binary or path variable the core and CLI source reads and fails on one the fixture leaves to the caller (SW-918).
