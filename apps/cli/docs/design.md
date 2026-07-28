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
- **Dependency swap:** argparse → commander, pyyaml → `yaml`, jinja2 → nunjucks
  (the four `infra/templates/*.j2` files use only nunjucks-compatible constructs
  and are reused unchanged).
- **1:1 module mapping** (same file names, `.ts`), behavior-preserving: identical
  flags, help text, output, exit codes, generated-file content.
- **Sync core, async at the edges:** subprocess calls use `spawnSync` (matching
  Python's sync flow); interactive prompts use `readline/promises`, so command
  `run()` is `async`.
- **Tests:** vitest; the highest-value Python test files (generate/config/slots/
  form_schema) are ported first; the remaining ~35 test files are a follow-up.

Conventions for the port live in `PORTING.md`.
