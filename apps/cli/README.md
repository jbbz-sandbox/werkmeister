# werkmeister

A multi-feature concurrent development orchestrator: run up to 12 isolated
feature environments side by side, each with its own containers, ports, and
ingress hostnames.

## Quick start

```sh
pnpm install
pnpm run build
./werkmeister --help
```

`./werkmeister` (alias `./w9r`; `./sandbox` is deprecated) resolves a node runtime
(WERKMEISTER_NODE → SANDBOX_NODE → PATH → newest nvm) and execs
`dist/main.js`. `sandbox hooks gate` bypasses the CLI import chain via
`dist/lib/gate.js` for a fast PreToolUse cold start.

## Tab completion

`sandbox __complete` answers bash's `complete -C` protocol (COMP_LINE/COMP_POINT
in, candidates on stdout), so both shells share one code path and there is no
generated completion script to keep in sync — candidates come off the commander
program itself.

`sandbox setup` installs it into `~/.zshrc` as a managed block (idempotent;
re-running replaces its own block and nothing else). To wire it up by hand, or
in bash, which setup does not touch:

```sh
autoload -Uz compinit && compinit          # zsh only; skip if your rc runs it
autoload -Uz +X bashcompinit && bashcompinit
complete -C 'sandbox __complete' sandbox
```

Completes subcommand names, a command's long flags, and any positional as a
feature name (`infra` plus the workspaces under the workspaces root).

## Layout

- `src/main.ts` — commander program (subcommand registry + dispatch)
- `src/commands/` — one module per subcommand (`run(args)` entrypoints)
- `src/lib/` — shared logic
- `infra/`, `bin/` — runtime data the CLI consumes as-is
- `CONVENTIONS.md` — the code conventions used throughout

## Notes

- CLI parsing is commander; templates in `infra/templates/*.njk` render through
  nunjucks with a small compat layer (`{% do %}`, dict truthiness,
  `map(attribute=…)`) so they stay shared verbatim with other consumers
- `sandbox mcp` runs the one MCP server over stdio. Its source is
  `apps/mcp`, bundled into `dist/mcp.js` by `esbuild.mjs` so it ships in the npm
  package. `sandbox dashboard` runs the localhost workspaces dashboard from
  `apps/sandbox-dashboard`, which is checkout-only
- interactive prompts and process-spawn edges are async (`run()` is
  `async` throughout); core logic stays synchronous
