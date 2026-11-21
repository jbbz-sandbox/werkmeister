---
"werkmeister-core": patch
"werkmeister": patch
---

SW-888: on macOS and Windows the host-load wait (a setup start in `feature up`, `with-temp-home`, the gate's retry) reads the Docker VM's load from a one-shot `alpine:3` container in place of the host's own load average, which never sees the VM (macOS) or is always 0 (Windows). A busy VM now holds back a setup start as host load does on Linux; an unreadable VM counts as not busy. `budget status` says `(Docker VM load on macOS)` or `(Docker VM load on Windows)`.
