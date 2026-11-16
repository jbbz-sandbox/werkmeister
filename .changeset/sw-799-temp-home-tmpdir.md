---
"werkmeister-core": patch
---

SW-799: `with-temp-home` exports `TMPDIR` as its temp dir, so scratch a wrapped command makes in `os.tmpdir()` (the scripts tests' `mkdtemp` dirs) is removed on exit instead of piling up in the host's temp folder.
