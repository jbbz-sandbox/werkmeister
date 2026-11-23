---
"werkmeister-core": patch
"werkmeister-mcp": patch
"werkmeister-ui": patch
---

SW-405: every package measures V8 unit-test coverage with `pnpm turbo run test:coverage`, which writes per-package HTML, lcov and summary reports and a merged `coverage/summary.json`. CI reports it on each pull request, with the change against main. Report only: no threshold. The builds now write source maps; the published `werkmeister-core` leaves them out. Core's `COVERAGE=1` switch (SW-756) is gone: use `test:coverage`. See docs/coverage.md.
