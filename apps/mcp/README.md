# werkmeister-mcp

The one werkmeister MCP server (SW-48): every tool, one name per verb, over
stdio (`werkmeister mcp`) and authenticated HTTP on :3002. Host-side: it holds
the Docker privilege so a container agent does not have to. The dashboard
(`apps/sandbox-dashboard`) has no MCP server of its own; its browser page calls
this one's `createServer()` in process.

## Why it exists

Self-hosting the sandbox gave a container the host's Docker socket, and the
daemon is root on the host. This server is the same capability with that mount
removed — the verbs over HTTP instead of a socket.

## Running it

`sandbox connect` starts it, like the dashboard: it is a `WebApp`
in `packages/sandbox-core/src/web_servers.ts` (stem `sandbox-mcp`, port 3002, PID
and log under `~/.sandbox`). A host-local MCP client gets it over stdio instead:

    sandbox mcp                            # stdio -- no token, no port

There is no transport flag on that verb: stdio is the only thing a client
launching a subprocess can use, and the HTTP mode is `sandbox connect`'s job.
`sandbox dashboard` is the same arrangement for the other app. By hand:

    npm run build && npm run serve:http    # Streamable HTTP on :3002
    npm run serve:stdio                    # what `sandbox mcp` execs

**It binds `0.0.0.0`, deliberately and uniquely.** `WebApp` carries an optional
per-app `env`, and only this app sets `HOST=0.0.0.0` — a container reaches the
host through `host.docker.internal`, and a loopback listener is unreachable that
way. The dashboard still binds loopback; do **not** try to arrange this by
exporting `HOST` before `sandbox connect`, because `start()` passes the
environment to both apps and the dashboard is unauthenticated.

## Authentication

32 random bytes of hex in `~/.sandbox/mcp-token`, mode 0600, created on first
start. A bearer token is required whenever the bind is not loopback — which,
under `sandbox connect`, is always. A host-local client should use `sandbox mcp`,
which needs no token. Any request carrying an `Origin` header is refused: this
server has no browser UI, so an `Origin` means a browser found something that
was not meant for it.

## How a container reaches it

`sandbox init-workspace` projects the workspace's `.mcp.json` from the
`mcp_servers:` registry in `~/.sandbox/services.yaml`. The `werkmeister` entry there
points at `http://host.docker.internal:3002/mcp`, carries the workspace's own
feature in `X-Sandbox-Feature`, and leaves `${SANDBOX_MCP_TOKEN}` for the MCP
client to expand from the container's environment. The token is never written
into that file — it lives inside a git worktree.

**The `werkmeister` entry is deliberately not listed in any archetype's
`mcp_servers:`,** so it is projected into no workspace by default. `.mcp.json`
is shared by host sessions and container sessions, and on the host
`host.docker.internal` does not resolve and `SANDBOX_MCP_TOKEN` is unset — so
wiring it everywhere would put a permanently failing server into every
workspace. Add `sandbox` to the archetype or entry of a workspace that is
actually driven from a container.

Workspace-scoped tools take one optional `workspace` argument — the workspace
directory name or its feature name — that overrides the header.

That covers a container the sandbox itself runs. For putting the *agent* in a
container, a Docker Sandbox microVM, or a full VM — what each needs mounted and
set, and which pieces stop working there — see "Running the agent itself in
isolation" in `docs/users-guide.md`.

## Watching it

`sandbox status` reports the *dashboard* under `mcp_web_server`, not this
server. Until that is widened, use:

    lsof -nP -iTCP:3002 -sTCP:LISTEN
    cat ~/.sandbox/sandbox-mcp.pid
    tail ~/.sandbox/sandbox-mcp.log

## Tools

| Group | Tools |
|-------|-------|
| Create | `create-workspace-form` (App UI: inline form, or the browser form; `issue` pre-fills), `create-workspace` (`formData` + `open`), `init-workspace`; UI-only: `workspace-form-schema`, `issue-form-data`, `refine-prompt` |
| List and lifecycle | `list-workspaces` (App UI), `status` (`detail` adds the host snapshot), `up`, `stop`, `restart`, `down`, `close-out`, `services`, `logs`, `test`, `remove-service`, `proxy-reload` |
| Open | `open-workspace` (VS Code), `open-feature` (tagged browser), `open-workspaces-ui` (the localhost dashboard) |
| Pull requests | `workspace-pr` (gate / open / status), `workspace-prs`, `open-prs`, `pr-approve`, `ask-pr-review`, `pr-reconcile` |
| Issues | `issue`; UI-only: `issue-statuses` |
| Context layer | `skills`, `hooks`, `notes`, `standards`, `detect` |
| Infra | `connect`, `intercept`, `docker-ui`, `k8s-forwards-status`, `kube-context`, `kube-switch`, `check-in`, `workspace-usage` |
| Claude sessions | `claude-transcript`, `claude-send`, `claude-resume`; UI-only: `claude-turn-status` |

UI-only tools carry `_meta.ui.visibility: ["app"]`: the MCP App calls them, the
model does not see them.

**The App UI.** `create-workspace-form` and `list-workspaces` carry
`_meta.ui.resourceUri` (`ui://workspace/mcp-app.html`, `ui://workspace/mcp-list.html`).
A client that advertises the `io.modelcontextprotocol/ui` capability (Claude
Desktop) renders them inline; any other client gets the browser form
(`form-cli.js`) or a markdown table. The HTML and the form are the dashboard's
build output, read from `apps/sandbox-dashboard/dist` beside the CLI, so they
exist in a checkout only; a package install takes the text fallback.

## What is not here

`setup` and `config`, permanently: they mutate the host machine's install and a
remote client cannot repair a broken `~/.zshenv` by calling an API. `clean`,
`stats` and `optimize`, for now: `clean` deletes volumes across every feature,
which is the wrong blast radius for a container-held token, and the other two
are simply not needed yet.
