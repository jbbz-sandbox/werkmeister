# sandbox

A multi-feature concurrent development orchestrator: run up to 12 isolated
feature environments side by side, each with its own containers, ports, and
ingress hostnames.

## Quick start

```sh
npm install
npm run build
./sandbox --help
```

`./sandbox` resolves a node runtime (SANDBOX_NODE → PATH → newest nvm) and execs
`dist/main.js`. `sandbox hooks gate` bypasses the CLI import chain via
`dist/lib/gate.js` for a fast PreToolUse cold start.

## Layout

- `src/main.ts` — commander program (subcommand registry + dispatch)
- `src/commands/` — one module per subcommand (`run(args)` entrypoints)
- `src/lib/` — shared logic
- `infra/`, `docs/standards/`, `bin/` — runtime data the CLI consumes as-is
- `CONVENTIONS.md` — the code conventions used throughout
- `docs/design.md` — scope and decisions

## Notes

- CLI parsing is commander; templates in `infra/templates/*.j2` render through
  nunjucks with a small compat layer (`{% do %}`, dict truthiness,
  `map(attribute=…)`) so they stay shared verbatim with other consumers
- `sandbox mcp` prints guidance — the MCP dashboard app lives in
  `apps/sandbox-dashboard` and is not duplicated here
- interactive prompts and process-spawn edges are async (`run()` is
  `async` throughout); core logic stays synchronous
