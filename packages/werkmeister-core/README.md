# werkmeister-core

The library behind the [werkmeister](https://www.npmjs.com/package/werkmeister) CLI. Build tools and UIs on its SDK, `werkmeister-core/sdk`.

## Install

Install the same version as the CLI you run (`werkmeister --version`):

```sh
npm i werkmeister-core@<your CLI version>
```

## Stability

Only `werkmeister-core/sdk` is public API and follows semver. Every other entry point, including the package root (`werkmeister-core`) and subpaths like `werkmeister-core/config`, is internal to werkmeister and can change in any release. `werkmeister-core` is versioned in lockstep with the werkmeister CLI: install the same version as the CLI you run. While the version is 0.x, a breaking change to `werkmeister-core/sdk` comes in a minor release, and its changelog entry says so.

## Example

List your workspaces and the ICM stage each one is on. Save as `list-stages.mjs` and run `node list-stages.mjs`:

```js
import { icmStage, listWorkspaces } from "werkmeister-core/sdk";

const { root, workspaces } = await listWorkspaces();
console.log(`workspaces under ${root}:`);
for (const ws of workspaces) {
  const s = await icmStage(ws.path);
  console.log(`${ws.name.padEnd(40)} ${s ? `${s.index}/${s.total} ${s.name}` : "-"}`);
}
```

The daemon's operations are reached with `callTool`. The full API is at [werkmeister.io/sdk](https://werkmeister.io/sdk/).

## Test coverage (contributors)

In a werkmeister checkout, `pnpm --filter werkmeister-core run test:coverage` builds `dist/` with source maps and runs the suite with Node's built-in coverage (Node 22.5 or later). It prints a coverage table after the usual output and writes lcov reports, mapped back to `src/*.ts`, to `$COVERAGE_DIR` (default `coverage/`, git-ignored): `lcov-isolated.info` and `lcov-shared.info`, one per `node --test` run. Off by default: `pnpm test` is unchanged. A CI shard (`pnpm test N/M`) reports only its own files, and the `test/*.smoke.mjs` smokes run as plain `node`, so they are not counted. The run costs about 40% more wall time and 35% more CPU (77 s against 55 s in a 3-CPU container). Run `pnpm build` afterwards to rebuild `dist/` without source maps.

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`.
