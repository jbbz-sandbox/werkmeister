---
"werkmeister": patch
---

SW-342: a workspace created from an issue now takes `services:` from the service names the issue spells out (within the chosen repos), so a plain `feature up` starts them. When nothing is local, `feature up` names the on-demand services and prints `start one with: werkmeister feature up --service <name>`, and the generated `werkmeister-context.md` How to validate says the same.
