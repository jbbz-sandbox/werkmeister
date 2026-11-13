# Werkmeister SDK

`werkmeister-core/sdk` is the one entry point that tools and UIs build on. It carries the
semver promise; every other `werkmeister-core` export is internal and can change in any release.
Its version moves with the CLI, and this reference matches the latest release.

## Install

`werkmeister-core` is not on npm yet. Install steps land here with its first npm release.

## Example: list workspaces and their stage

```js
import { icmStage, listWorkspaces } from "werkmeister-core/sdk";

const { root, workspaces } = await listWorkspaces();
console.log(`workspaces under ${root}:`);
for (const ws of workspaces) {
  const s = await icmStage(ws.path);
  console.log(`${ws.name.padEnd(40)} ${s ? `${s.index}/${s.total} ${s.name}` : "-"}`);
}
```

{@link listWorkspaces} and {@link icmStage} read the workspace folders in-process, so the
script runs on the machine that holds them. It needs no daemon.

## The daemon

Operations that run in the werkmeister daemon go through {@link callTool}: it posts
`{ name, arguments }` to the daemon's `POST /api/tool` and returns a {@link ToolResult}.
It throws {@link DaemonUnavailable} when the daemon is down.

- **Token:** every request carries the bearer token from `~/.werkmeister/mcp-token`.
  `callTool` reads it for you.
- **No browsers:** the daemon refuses any request with an `Origin` header. A browser UI
  can't call it directly; it goes through a local server of its own that calls `callTool`.

## What `icmStage` returns

{@link icmStage} returns the first `stages/NN_*` folder whose `output/` holds no file other
than dot files, so a stage with only `.gitkeep` is still the current one. It returns `null`
when every stage has output, or when the workspace has no `stages/` folder.

A stage reads as done as soon as anything lands in its `output/`, a draft included, even
before anyone approves it.
