# sandbox CLI design

**Date:** 2026-07-21

## Scope

The CLI itself — `src/main.ts`, the `lib/` modules, the `commands/` modules, and
the `./sandbox` launcher. The dashboard (`apps/sandbox-dashboard`) is a separate
app and is not duplicated here. Runtime data the CLI consumes (`infra/`,
`docs/standards/`, `bin/` shell helpers) lives alongside it, so this package is
standalone and runnable.

## Decisions

- **Node ≥20, ESM, tsc build** (`src/` → `dist/`), no bundler. `./sandbox` wrapper
  execs `node dist/main.js`.
- **Dependencies kept to three:** commander (CLI parsing), `yaml`, nunjucks (the
  four `infra/templates/*.njk` files use only nunjucks-compatible constructs and
  are shared verbatim with other consumers).
- **One module per command, one per shared concern**, behavior-preserving:
  flags, help text, output, exit codes, and generated-file content are contracts.
- **Sync core, async at the edges:** subprocess calls use `spawnSync`;
  interactive prompts use `readline/promises`, so command `run()` is `async`.
- **Tests:** vitest, covering the highest-value modules first (generate/config/
  slots/form_schema); broader coverage is a follow-up.

Code conventions live in `../CONVENTIONS.md`.
