# Code conventions — `src/`

Conventions this CLI holds itself to. They exist because the runtime data in
`infra/` is consumed as-is and much of the output is
contract-shaped: generated files, exit codes, and printed text are depended on
by other tooling, so they are not free to drift.

## Layout

| Path | Holds |
|---|---|
| `src/main.ts` | the commander program and command registry |
| `src/commands/<name>.ts` | one module per CLI command |
| `src/commands/<command>.help.md` | that command's long help: printed after its options by `--help`, and the source of its users-guide section and man page (`pnpm run docs:gen`) |
| `src/lib/<name>.ts` | shared library modules |

Runtime data dirs live alongside the source: `infra/`, `bin/`.
Path resolution: package root = `WERKMEISTER_ROOT` / `WERKMEISTER_ROOT` env, else the first
ancestor holding `apps/cli` (`sandboxRoot()` / `infraRoot()` in
`packages/werkmeister-core/src/config.ts`, re-exported by `src/lib/config.ts` as
`getSandboxRoot()` / `getInfraRoot()`).

## Language

- **ESM + NodeNext**: every relative import ends in `.js`
  (`import { x } from "./config.js"`).
- Keep a module docstring at the top of each file explaining what it owns.
- Functions/vars are `camelCase`; classes/types `PascalCase`; module-level
  private constants `_UPPER_SNAKE`.
- **The CLI surface is frozen**: flag names, defaults, help text, printed
  output, exit codes, and JSON shapes are contracts. Changing one is a
  deliberate, breaking change — not a cleanup.
- YAML via the `yaml` package (`parse`, `stringify`).
- Templates in `infra/templates/` are rendered with `nunjucks`. They are shared
  verbatim with other consumers, so the environment options in `generate.ts`
  (autoescape, trim/lstrip) are load-bearing — see the notes there before
  touching them.
- Subprocesses go through `packages/werkmeister-core/src/proc.ts` (spawnSync-based, synchronous):
  - `run(cmd: string[], opts)` → `{ status, stdout, stderr }`; `check: true` throws `ProcError`.
  - `capture(cmd)` → trimmed stdout, throws on failure.
  - Streaming/inherit-stdio cases: pass `stdio: "inherit"`.
  - `timeout` is in **seconds**, not milliseconds.
- Filesystem work uses the sync `node:fs` API (`readFileSync` etc.) plus `node:path`.
- ANSI colors come from `packages/werkmeister-core/src/colors.ts` — the single definition site.
- `console.error` for stderr, `console.log` for stdout.
- `process.exit(n)` for exit codes. Thrown errors reach `main`, which prints
  `Error: <msg>` in red and exits 1; `WERKMEISTER_DEBUG` re-raises with a stack.
- Interactive prompts use `node:readline/promises`, which makes the enclosing
  function `async` — command `run()` signatures are `async (args) => Promise<void>`.
- No new npm dependencies beyond: commander, nunjucks, yaml.
- Tests are vitest, in `src/lib/__tests__/<name>.test.ts`.

## Behavior rules

- Keep comments that explain *why*; drop line-by-line *what* comments.
- `gate.ts` is deliberately dependency-light (it backs a PreToolUse hook with a
  cold-start budget): it must not import commander/yaml/nunjucks, and must stay
  runnable directly via `node dist/lib/gate.js` — it has a `main()` guard.
