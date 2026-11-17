---
"werkmeister-core": patch
---

`machine config --write`, `machine setup` and `machine migrate` now refuse to write the machine config or `env.sh` from inside any container, even with `WERKMEISTER_FEATURE` unset, the same way compose generation has refused since SW-554. The two guards are now one, `refuseInsideContainer`, and `WERKMEISTER_CONFIG_FILE` still lets a scratch run write (SW-572).
