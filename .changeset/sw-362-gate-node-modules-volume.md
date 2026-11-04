---
"werkmeister": patch
"werkmeister-core": patch
---

The `werkmeister-install` one-shot runs `pnpm install --frozen-lockfile` on every run instead of skipping while the lockfile stamps match: pnpm's own up-to-date check takes seconds and restores a package missing under the `node_modules` volume, which the stamps cannot see; the npm path keeps the stamp skip (SW-362). The PR gate runs that one-shot once for a container it keeps: `compose up` of a running service leaves it as is and re-runs the exited setup, so a kept container's rows run on a checked volume. Its `containers` row reads `kept (… already running, setup one-shot re-run)`.
