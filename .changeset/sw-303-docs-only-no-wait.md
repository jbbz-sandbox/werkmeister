---
"werkmeister": patch
---

`pr gate` and `pr open` no longer wait for host load on a diff that touches no service (docs only, `no_service_paths`): lint and the release check run at once, since no test suite runs (SW-303).
