---
"werkmeister": patch
"werkmeister-core": patch
---

`generate-certs.sh` now pins its own locale (`LC_ALL=C`; every value it handles is an ASCII hostname), so the certificate step of `machine setup` no longer depends on the caller's locale. When the script fails, it prints the line that failed and its exit code, and setup's step points at that line instead of reporting only the exit code (SW-642).
