---
"werkmeister": patch
"werkmeister-core": patch
---

A `pr gate` / `pr open` that waits out capacity no longer reads as a failure (SW-981). Each service's capacity wait prints once (a second attempt that waited again adds no row), the lint, test, baseline and release rows it left without a container read `not run: waiting on capacity`, and every such row is marked `-`, not `✗`. The exit stays 75.
