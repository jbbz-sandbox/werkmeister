---
"werkmeister": patch
---

SW-1177: `with-temp-home --clean-home` fails a command that wrote its temp HOME's `.werkmeister`, listing what it wrote; `werkmeister pr gate` passes it, so a test that writes there fails the gate as CI's `require-clean-home.sh` does.
