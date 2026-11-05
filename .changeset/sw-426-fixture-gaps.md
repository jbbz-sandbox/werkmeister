---
"werkmeister": patch
---

`with-fixture-workspace` gains `--fragment <file>` (so `registry sync` runs under the fixture) and `--daemon` (a fake daemon that logs each call); without `--daemon` the daemon address is dead even when the shell exports the real one. `--gate` with a `--services` registry that has no `lib` now exits 2 instead of seeding a change no service maps to. Core tests get `withFakeDaemon` (SW-426).
