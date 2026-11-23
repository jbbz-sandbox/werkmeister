---
"werkmeister": patch
---

A registry `path_mappings` entry can name a list of services, so a shared package maps to the services that import it instead of touching every service in the gate. The werkmeister repo maps `packages/werkmeister-ui` to werkmeister-dashboard, werkmeister-vscode and werkmeister-core (SW-1087).
