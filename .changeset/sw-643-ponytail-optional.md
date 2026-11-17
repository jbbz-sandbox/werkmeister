---
"werkmeister": patch
"werkmeister-core": patch
---

`machine setup` no longer installs the ponytail plugin on every machine. Like superpowers, it is now an optional plugin, and the wizard asks about each optional plugin separately. A machine that already has ponytail keeps it, setup keeps it current, and `machine setup --check` does not report it either way (SW-643).
