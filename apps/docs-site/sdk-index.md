# Werkmeister SDK

`werkmeister-core/sdk` is the one entry point that tools and UIs build on. This reference matches
the latest release.

Only `werkmeister-core/sdk` is public API and follows semver. Every other entry point, including
the package root (`werkmeister-core`) and subpaths like `werkmeister-core/config`, is internal to
werkmeister and can change in any release. werkmeister's own apps, the MCP server and the CLI, import those
internal entries, not the SDK; `docs/sdk-parity.md` in the werkmeister repo maps each of their
tools and commands to the SDK export that does the same job. `werkmeister-core` is versioned in lockstep with the
werkmeister CLI: install the same version as the CLI you run. While the version is 0.x, a breaking
change to `werkmeister-core/sdk` comes in a minor release, and its changelog entry says so.

## Install

Install the same version as the CLI you run (`werkmeister --version`), on Node 22 or later:

```sh
npm i werkmeister-core@<your CLI version>
```

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

## Lifecycle

A workspace's own containers start and stop through {@link runWorkspaceAction}, which takes the
workspace's name and one of {@link WORKSPACE_ACTIONS}:

```js
import { runWorkspaceAction } from "werkmeister-core/sdk";

const { command, output, path } = await runWorkspaceAction("my-workspace", "up");
console.log(`${command} in ${path}\n${output}`);
```

It throws {@link WorkspaceError}, with the transcript attached, when the action fails (for example
stopping a workspace that isn't running). `down` through `runWorkspaceAction` keeps the volumes;
to remove them too, call the daemon's `down` tool with `removeVolumes: true`.

The shared infrastructure every workspace routes through (Caddy and the k8s port-forwards) has
its own verbs: {@link infraUp}, {@link infraDown}, {@link infraStop} and {@link infraRestart}.
{@link infraHealth} waits for it to report healthy, and {@link connectK8s} restarts only the
port-forwards. `werkmeister infra connect` runs `infraUp` and then `infraHealth`, then checks
the issue tracker.

## callTool reference

{@link callTool} takes a tool's name and its arguments as one object:
`callTool("services", { workspace: "my-workspace" })`. Leave `workspace` out only when you pass
`callTool` a per-workspace token (`opts.token`); it then defaults to that token's workspace.
UI-only tools render an interface in an MCP App client and return little to a script.

<!-- generated:sdk-call-tools -->

60 tools.

| Tool | What it does | Arguments |
| --- | --- | --- |
| `up` | Bring a feature up | `workspace?: string` |
| `down` | Tear a feature down | `workspace?: string`, `removeVolumes?: boolean` |
| `stop` | Stop a feature's containers | `workspace?: string` |
| `pause` | Pause a workspace | `workspace?: string` |
| `resume` | Resume a paused workspace | `workspace?: string` |
| `restart` | Restart a feature's containers | `workspace?: string` |
| `detect` | Generate a repo's service-registry fragment | `repo: string`, `write?: boolean`, `answers?: object[]` |
| `services` | Where a feature's services answer | `workspace?: string` |
| `logs` | Read a feature's container logs | `workspace?: string`, `service?: string`, `tail?: integer` |
| `remove-service` | Drop a service from a feature | `workspace?: string`, `service: string` |
| `test` | Run a feature's Playwright suite | `workspace?: string`, `extraArgs?: string[]` |
| `proxy-reload` | Regenerate and reload the reverse proxy | none |
| `close-out` | End a workspace | `workspace?: string`, `abandon?: string`, `skip_postmortem?: string`, `no_pr?: string`, `keep_open?: boolean` |
| `init-workspace` | Reconcile a workspace | `workspace?: string`, `repos?: string`, `services?: string`, `issue_id?: string`, `work_type?: string`, `task?: string`, `description?: string`, `labels?: string`, `group?: string`, `test_path?: string`, `starting_prompt?: string`, `context_strategy?: "icm" \| "jit"` |
| `skills` | Check or sync a workspace's context layer | `workspace?: string`, `action: "check" \| "sync"` |
| `standards` | Validate the standards tree | none |
| `hooks` | Refresh a workspace's context layer | `workspace?: string` |
| `notes` | Read or graduate a workspace's notes | `workspace?: string`, `action: "context" \| "list" \| "graduate"`, `includeSuperseded?: boolean`, `notePath?: string`, `domain?: string`, `kind?: "rule" \| "example" \| "anti-pattern"`, `slug?: string` |
| `connect` | Start shared infrastructure | `k8sOnly?: boolean` |
| `open-feature` | Open a feature-tagged browser window | `workspace?: string`, `url?: string`, `path?: string`, `size?: string`, `position?: string` |
| `intercept` | Start or leave a k8s traffic intercept | `workspace?: string`, `action: "start" \| "leave"`, `service?: string` |
| `create-workspace-form` | New Werkmeister Workspace | `issue?: string`, `open?: boolean` |
| `create-workspace` | Create Workspace | `formData: object`, `open?: boolean` |
| `workspace-form-schema` | Workspace Form Schema (UI-only) | none |
| `issue-form-data` | Issue → Form Fields (UI-only) | `ref: string` |
| `refine-prompt` | Refine Prompt (UI-only) | `text: string`, `instruction?: string`, `formData?: object` |
| `list-workspaces` | List Werkmeister Workspaces | none |
| `open-workspaces-ui` | Open Workspaces Dashboard in Browser | none |
| `open-workspace` | Open Workspace in VS Code | `workspace?: string` |
| `workspace-prs` | Workspace Pull Requests | none |
| `issue-statuses` | Issue Statuses (UI-only) | `refs: string[]`, `refresh?: boolean` |
| `open-prs` | Open Pull Requests | none |
| `pr-approve` | Approve Pull Request | `url: string` |
| `ask-pr-review` | Ask for PR Review | `url: string`, `title?: string`, `author?: string` |
| `issue` | Issue Card | `ref: string` |
| `pr-reconcile` | Reconcile PR with Issue | `url: string`, `issueRef?: string` |
| `workspace-pr` | Workspace PR: gate, open, status | `workspace?: string`, `action: "gate" \| "open" \| "status"`, `repo?: string` |
| `status` | Werkmeister status | `detail?: boolean` |
| `check-in` | Check-in Triage | none |
| `workspace-usage` | Workspace Token Usage | `workspace?: string` |
| `docker-ui` | Docker Container UI | none |
| `k8s-forwards-status` | k8s Forwards Health | none |
| `kube-context` | Current Kube Context | none |
| `kube-switch` | Switch Kube Context | `env?: "dev" \| "stage" \| "prod"` |
| `claude-transcript` | Claude Code Session Transcript | `workspace?: string`, `limit?: integer`, `sessionId?: string` |
| `relay-check` | Relay Check | `workspace?: string`, `sentAt: string`, `text: string` |
| `claude-send` | Send to Claude Code Session | `workspace?: string`, `message: string`, `sessionId?: string` |
| `claude-turn-status` | Claude Turn Status (UI-only) | `workspace?: string` |
| `claude-resume` | Resume Claude Session in Terminal | `workspace?: string`, `sessionId?: string`, `new?: boolean`, `prompt?: string` |
| `clean` | Remove orphaned volumes and stale slots | `all?: boolean`, `dryRun?: boolean` |
| `stats` | Container resource usage | `collect?: number`, `interval?: integer`, `save?: boolean` |
| `optimize` | Usage against configured limits | `collect?: number`, `interval?: integer` |
| `metrics` | Flow metrics | `range?: "7d" \| "30d" \| "90d" \| "all"`, `workspace?: string` |
| `metrics-trends` | Metrics trends | `range?: "7d" \| "30d" \| "90d" \| "all"`, `bucket?: "day" \| "week"` |
| `cache` | Prune the shared build caches | `name?: string`, `reset?: boolean`, `force?: boolean`, `dryRun?: boolean` |
| `registry` | Regenerate the service registry | `check?: boolean` |
| `resources` | CPU and memory per workspace | none |
| `budget` | Scheduler budget, running and waiting | none |
| `intercepts` | Telepresence intercept state | none |
| `scheduler` | Slot leases and the waiting queue | `op: "allocate" \| "lease" \| "release" \| "admit" \| "grant" \| "grant-later" \| "queue"`, `feature?: string`, `workspace?: string \| null`, `preferredSlot?: integer \| null`, `byPerson?: boolean`, `starting?: object`, `fromQueue?: boolean` |

<!-- /generated -->

## What `icmStage` returns

{@link icmStage} returns the first `stages/NN_*` folder whose `output/` holds no file other
than dot files, so a stage with only `.gitkeep` is still the current one. It returns `null`
when every stage has output, or when the workspace has no `stages/` folder.

A stage reads as done as soon as anything lands in its `output/`, a draft included, even
before anyone approves it.
