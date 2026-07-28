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

- `src/main.ts` — commander program (argparse-parity subcommands + dispatch)
- `src/commands/` — one module per subcommand (`run(args)` entrypoints)
- `src/lib/` — shared logic, one-to-one with the Python `cli/lib/`
- `infra/`, `docs/standards/`, `bin/` — runtime data, copied verbatim from the source repo
- `PORTING.md` — the Python→TS conventions used throughout
- `docs/design.md` — scope and decisions for the port

## Differences from the Python original

- argparse → commander (help layout differs; flags/behavior do not)
- jinja2 → nunjucks with a compat layer (`{% do %}`, dict truthiness,
  `map(attribute=…)`); templates unchanged on disk
- pyyaml → `yaml`
- `sandbox mcp` prints guidance — the MCP dashboard app lives in the original
  repo and is already TypeScript; it is not duplicated here
- interactive prompts and process-spawn edges are async (`run()` is
  `async` throughout); core logic stays synchronous like the Python
