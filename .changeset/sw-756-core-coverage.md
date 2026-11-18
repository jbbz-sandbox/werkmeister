---
"werkmeister-core": patch
---

werkmeister-core's test runner takes `COVERAGE=1` (and `pnpm run test:coverage`, which builds with source maps first): Node's built-in coverage, with lcov reports mapped back to `src/` in `$COVERAGE_DIR` (default `coverage/`). Off by default; the README's "Test coverage" section has the caveats (SW-756).
