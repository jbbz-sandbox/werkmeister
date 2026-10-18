---
"werkmeister": minor
---

Renamed the CLI package (formerly `sandbox-cli` under the `@jbbz-sandbox` scope) to the unscoped `werkmeister` (SW-5). It ships two bins, `werkmeister` and `w9r`. The old `sandbox` bin still works but is deprecated: it prints a one-line notice on stderr, then runs as before. It will be removed in SW-11.

To migrate, uninstall the old scoped package globally, then run `npm install -g werkmeister`.
