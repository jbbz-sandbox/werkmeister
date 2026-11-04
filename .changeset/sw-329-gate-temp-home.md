---
"werkmeister": patch
---

The pr gate's lint, test and release commands now run inside the container through the `with-temp-home` script (inline, with `--no-wait`), so a gate test run can no longer read or write the real `~/.werkmeister` the container mounts (SW-329).
