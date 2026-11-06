---
"werkmeister-core": patch
---

SW-470: the fixture parses a `--services` registry only under `--gate`, so a YAML error without it reaches `workspace init`'s own error.
