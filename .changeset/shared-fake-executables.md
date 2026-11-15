---
"werkmeister": patch
"werkmeister-core": patch
---

The fixture's fake `gh` and `docker` are one shared copy per user under the temp dir (`werkmeister-shared-<uid>/<hash>`), symlinked into each fixture, instead of a new file each run. macOS checks every newly written executable on its first run (~0.5 s), so a fixture or `withFakeGh` test paid that twice per run; it now pays it once per machine. Falls back to a private copy if the shared folder isn't the user's own.
