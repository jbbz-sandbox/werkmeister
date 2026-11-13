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

## Limits

Functions that start or create things (`up`, `createWorkspace` …) need `WERKMEISTER_ROOT` set to the CLI package directory, for example `$(npm root -g)/werkmeister`, until [SW-695](https://jory-group.atlassian.net/browse/SW-695).

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`.
