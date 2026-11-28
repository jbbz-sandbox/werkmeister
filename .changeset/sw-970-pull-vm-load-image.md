---
"werkmeister": patch
---

SW-970: `machine setup` pulls `alpine:3` on macOS and Windows, the image the Docker VM load probe runs, so the probe's 4 s cap no longer spends itself on a first pull and the scheduler reads the VM's load from the start. A failed pull is an optional warning; `--check` reports a missing image without pulling it.
