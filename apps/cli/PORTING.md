# Code conventions — `src/`

Conventions this CLI holds itself to. They exist because the runtime data in
`infra/` and `docs/standards/` is consumed as-is and much of the output is
contract-shaped: generated files, exit codes, and printed text are depended on
by other tooling, so they are not free to drift.

## Layout

| Path | Holds |
|---|---|
| `src/main.ts` | the commander program and command registry |
| `src/commands/<name>.ts` | one module per CLI command |
| `src/lib/<name>.ts` | shared library modules |

Runtime data dirs live alongside the source: `infra/`, `docs/standards/`, `bin/`.
Path resolution: repo root = `SANDBOX_ROOT` env, else two levels up from
`dist/lib/` (`src/lib/config.ts` owns `getSandboxRoot()` / `getInfraRoot()`).

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
- Subprocesses go through `src/lib/proc.ts` (spawnSync-based, synchronous):
  - `run(cmd: string[], opts)` → `{ status, stdout, stderr }`; `check: true` throws `ProcError`.
  - `capture(cmd)` → trimmed stdout, throws on failure.
  - Streaming/inherit-stdio cases: pass `stdio: "inherit"`.
  - `timeout` is in **seconds**, not milliseconds.
- Filesystem work uses the sync `node:fs` API (`readFileSync` etc.) plus `node:path`.
- ANSI colors come from `src/lib/colors.ts` — the single definition site.
- `console.error` for stderr, `console.log` for stdout.
- `process.exit(n)` for exit codes. Thrown errors reach `main`, which prints
  `Error: <msg>` in red and exits 1; `SANDBOX_DEBUG` re-raises with a stack.
- Interactive prompts use `node:readline/promises`, which makes the enclosing
  function `async` — command `run()` signatures are `async (args) => Promise<void>`.
- No new npm dependencies beyond: commander, nunjucks, yaml.
- Tests are vitest, in `src/lib/__tests__/<name>.test.ts`.

## Behavior rules

- Keep comments that explain *why*; drop line-by-line *what* comments.
- `gate.ts` is deliberately dependency-light (it backs a PreToolUse hook with a
  cold-start budget): it must not import commander/yaml/nunjucks, and must stay
  runnable directly via `node dist/lib/gate.js` — it has a `main()` guard.
