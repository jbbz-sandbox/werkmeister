---
"werkmeister": minor
---

`werkmeister registry sync` skips repos listed in `disabled_fragments` in `~/.werkmeister/services.local.yaml`, leaving their services, setup_services and infrastructure out of the registry, and reports each skip. (SW-129)
