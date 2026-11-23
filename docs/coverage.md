# Test coverage

Every werkmeister package measures its unit-test coverage with V8, through the `test:coverage` turbo task. CI reports it on each pull request. Plain `test` measures nothing and is unchanged.

## Run it

From a checkout, after `pnpm install`:

```bash
pnpm turbo run test:coverage                                 # every package, then the merged summary
pnpm --filter werkmeister-core run test:coverage             # one package
```

The core, CLI and MCP tests refuse a HOME that holds a real `~/.werkmeister`. On a machine with one, run them in a workspace container through its temp-HOME wrapper, as for `test`:

```bash
docker exec -w /app <feature>-werkmeister-core <workspace>/.werkmeister/bin/with-temp-home pnpm turbo run test:coverage
```

| Package | Measured with |
|---|---|
| `werkmeister` (`apps/cli`) | vitest's `@vitest/coverage-v8` (`vitest run --coverage`) |
| `werkmeister-core`, `werkmeister-mcp`, `werkmeister-ui`, `werkmeister-vscode`, `docs-site`, `werkmeister-dashboard` | [c8](https://github.com/bcoe/c8) around the package's own test command |

Both read V8's coverage and map it back to the `.ts` source through the source maps the build writes (`"sourceMap": true` in each emitting `tsconfig`). `docs-site` has no TypeScript: its hand-written `.mjs` is measured as is. [`scripts/coverage-run.mjs`](../scripts/coverage-run.mjs) runs each package's command and also records its test count and wall time.

## Where the reports land

| Path | Holds |
|---|---|
| `<package>/coverage/index.html` | the HTML report, per file and line |
| `<package>/coverage/lcov.info` | lcov, for an editor's coverage gutter |
| `<package>/coverage/coverage-summary.json` | istanbul's summary: lines, branches, functions, statements, per file and in total |
| `<package>/coverage/run.json` | `{ "tests", "duration_ms" }` of the run; `tests` is `null` when the runner prints no count (the dashboard's smoke scripts) |
| `coverage/summary.json`, `coverage/summary.md` | every package merged, with a total computed from the summed counts, written by [`scripts/coverage-summary.mjs`](../scripts/coverage-summary.mjs) |

All of them are git-ignored, and turbo never replays the task from its cache: a replayed run would report an old duration.

## In CI

The `coverage` job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every pull request and merge-queue run. It doesn't run on pushes to main: the merge-queue run of the same commit stands for main.

- **Job summary**: the merged table, with each metric's change in points against the last successful merge-queue run. A package that run didn't have shows "(new)". The first run, with nothing to compare, says there is no baseline.
- **Artifacts**: `coverage-html` (every package's `coverage/` folder) and `coverage-summary` (`coverage/summary.json`, which later runs read as their baseline).

There is no threshold: the job fails only when a test command can't run its tests, never on the numbers, and it isn't a required check.

## In the metrics ledger

Each package's numbers become a `coverage` event in `~/.werkmeister/metrics/events-YYYY-MM.jsonl`, one per package per run: lines, branches, functions and statements %, the test count and duration, the measured commit, and `version` as `<package version>+<short sha>`. `source` says where the run happened:

| `source` | Written by |
|---|---|
| `gate` | `werkmeister pr gate`, for each `coverage/coverage-summary.json` its test rows wrote. werkmeister's own rows run `test:coverage`; a repo whose test command writes that file is read the same way |
| `ci-pr`, `ci-main` | `werkmeister metrics rebuild`, from the `coverage-summary` artifacts of the GitHub repos its PR files point at, through the `gh` login it already uses. A merge-queue run counts as main. Each run is read once |

At close-out, `coverage.json` on the record branch holds the coverage of each PR's changed files, from the reports newer than its last commit, with `notMeasured` listing changed source files no test loaded. With no such report, close-out writes no file.

Nothing to set up: after upgrading, the gate rows change with the repo's `services.yaml`, and the next `metrics rebuild` imports the CI runs still in GitHub's artifact retention.

## Limits

- Only files a test loads are counted. A source file no test imports doesn't appear in the report, rather than showing as 0 %.
- The CLI's BDD suite (`bdd/`) and the suites that need a real Docker daemon aren't measured.
- A server a test starts as a child process and stops with a signal reports nothing, for example the MCP server's `dist/main.js`. The code it runs counts only where a test imports it directly.
- c8 adds about a quarter to a suite's wall time (core: 121 s against 97 s, mean of three paired runs).
