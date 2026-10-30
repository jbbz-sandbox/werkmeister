# werkmeister-mcp

The one werkmeister MCP server (SW-48): every tool, one name per verb, over
stdio (`werkmeister mcp`) and authenticated HTTP on :3002. Host-side: it holds
the Docker privilege so a container agent does not have to. The dashboard
(`apps/werkmeister-dashboard`) has no MCP server of its own; its browser page calls
this one's `createServer()` in process.

## Why it exists

Self-hosting werkmeister gave a container the host's Docker socket, and the
daemon is root on the host. This server is the same capability with that mount
removed — the verbs over HTTP instead of a socket.

## Running it

Over HTTP this is the **host daemon** (SW-184): the one process that holds the
Docker privilege for every client — container agents over `/mcp`, the VS Code
extension and the CLI's SessionEnd auto-stop over `/api/tool` and
`/api/logs/stream`.

On macOS `werkmeister setup` installs it as the launchd agent
`com.werkmeister.daemon` (`KeepAlive`, so it restarts if it dies); from then on
`werkmeister connect`/`stop`/`restart` hand it to launchd rather than touching a PID file.
Elsewhere `werkmeister connect` starts it, like the dashboard: it is a `WebApp`
in `packages/werkmeister-core/src/web_servers.ts` (stem `sandbox-mcp`, PID <!-- name-check: ignore -->
and log under `~/.werkmeister`). The port is 3002, or `overrides.mcp_port`
(`WERKMEISTER_MCP_PORT`). A host-local MCP client gets it over stdio instead:

    werkmeister mcp                          # stdio -- no token, no port

There is no transport flag on that verb: stdio is the only thing a client
launching a subprocess can use, and the HTTP mode is `werkmeister connect`'s job.
`werkmeister dashboard` is the same arrangement for the other app. By hand:

    pnpm run build && pnpm run serve:http    # Streamable HTTP on :3002
    pnpm run serve:stdio                     # what `werkmeister mcp` execs

**It binds `0.0.0.0`, deliberately and uniquely.** `WebApp` carries an optional
per-app `env`, and only this app sets `HOST=0.0.0.0` — a container reaches the
host through `host.docker.internal`, and a loopback listener is unreachable that
way. The dashboard still binds loopback; do **not** try to arrange this by
exporting `HOST` before `werkmeister connect`, because `start()` passes the
environment to both apps and the dashboard is unauthenticated.

## Authentication

Two kinds of bearer token, both 32 random bytes of hex at mode 0600:

- **The machine token**, `~/.werkmeister/mcp-token`, created on first start: every
  tool and every endpoint. Host clients (VS Code, the CLI) send it.
- **A workspace token**, `~/.werkmeister/tokens/<workspace>`, written by
  `init-workspace` (with a copy in the workspace's git-ignored
  `.werkmeister/token` for a container to read) and deleted at close-out. On
  `/mcp` it lists only the workspace verbs (`src/scope.ts`), each defaults to
  that workspace, and naming any other workspace fails with code `SCOPE`.
  `/api/tool` refuses it. It is an identity, not a security boundary, while
  `~/repos` and `~/features` mount read-write into the container.

A bearer token is required whenever the bind is not loopback — which,
under the daemon, is always. A host-local client should use `werkmeister mcp`,
which needs no token. Any request carrying an `Origin` header is refused: this
server has no browser UI, so an `Origin` means a browser found something that
was not meant for it.

## Endpoints

| Route | Token | What |
| --- | --- | --- |
| `/mcp` | machine or workspace | Streamable HTTP MCP, stateless |
| `POST /api/tool` | machine | `{ name, arguments }` → `{ structuredContent, text }`, or 400 `{ error, code }` |
| `GET /api/logs/stream?feature=<ws>&service=<svc>` | machine, or the workspace's own | SSE: each `data:` is a JSON string chunk; `event: end` when the containers stop |

`WERKMEISTER_FIXTURE=1` keeps the daemon (and any core caller) off Caddy, k8s
forwards, telepresence, `/etc/hosts` and the real `gh`: the switch tests use.

## How a container reaches it

`werkmeister init-workspace` projects the workspace's `.mcp.json` from the
`mcp_servers:` registry in `~/.werkmeister/services.yaml`. The `werkmeister` entry there
points at `http://host.docker.internal:${WERKMEISTER_MCP_PORT:-3002}/mcp` and leaves
`${WERKMEISTER_MCP_TOKEN}` for the MCP client to expand from the container's
environment: set it from the workspace's `.werkmeister/token`, which names the workspace. The token is never written
into that file — it lives inside a git worktree.

**The `werkmeister` entry is deliberately not listed in any archetype's
`mcp_servers:`,** so it is projected into no workspace by default. `.mcp.json`
is shared by host sessions and container sessions, and on the host
`host.docker.internal` does not resolve and `WERKMEISTER_MCP_TOKEN` is unset — so
wiring it everywhere would put a permanently failing server into every
workspace. Add `werkmeister` to the archetype or entry of a workspace that is
actually driven from a container.

Workspace-scoped tools take one optional `workspace` argument — the workspace
directory name or its feature name — that overrides the `X-Werkmeister-Feature`
header and, under a workspace token, must name that same workspace.

That covers a container werkmeister itself runs. For putting the *agent* in a
container, a Docker Sandbox microVM, or a full VM — what each needs mounted and <!-- name-check: ignore -->
set, and which pieces stop working there — see "Running the agent itself in
isolation" in `docs/users-guide.md`.

## Watching it

`werkmeister status` reports the *dashboard* under `mcp_web_server`, not this
server. Until that is widened, use:

    lsof -nP -iTCP:3002 -sTCP:LISTEN
    cat ~/.werkmeister/sandbox-mcp.pid # name-check: ignore
    tail ~/.werkmeister/sandbox-mcp.log # name-check: ignore

## Tools

<!-- generated:mcp-tools -->

55 tools (6 UI-only).

| Tool | What it does |
| --- | --- |
| `clean` | Remove orphaned volumes and stale slots |
| `stats` | Container resource usage |
| `optimize` | Usage against configured limits |
| `cache` | Prune the shared build caches |
| `registry` | Regenerate the service registry |
| `resources` | CPU and memory per workspace |
| `intercepts` | Telepresence intercept state |
| `up` | Bring a feature up |
| `down` | Tear a feature down |
| `stop` | Stop a feature's containers |
| `pause` | Pause a workspace |
| `resume` | Resume a paused workspace |
| `restart` | Restart a feature's containers |
| `detect` | Generate a repo's service-registry fragment |
| `services` | Where a feature's services answer |
| `logs` | Read a feature's container logs |
| `remove-service` | Drop a service from a feature |
| `test` | Run a feature's Playwright suite |
| `proxy-reload` | Regenerate and reload the reverse proxy |
| `close-out` | End a workspace |
| `init-workspace` | Reconcile a workspace |
| `skills` | Check or sync a workspace's context layer |
| `standards` | Validate the standards tree |
| `hooks` | Refresh a workspace's context layer |
| `notes` | Read or graduate a workspace's notes |
| `connect` | Start shared infrastructure |
| `open-feature` | Open a feature-tagged browser window |
| `intercept` | Start or leave a k8s traffic intercept (UI-only) |
| `create-workspace-form` | New Werkmeister Workspace |
| `create-workspace` | Create Workspace |
| `workspace-form-schema` | Workspace Form Schema (UI-only) |
| `issue-form-data` | Issue → Form Fields (UI-only) |
| `refine-prompt` | Refine Prompt (UI-only) |
| `list-workspaces` | List Werkmeister Workspaces |
| `open-workspaces-ui` | Open Workspaces Dashboard in Browser |
| `open-workspace` | Open Workspace in VS Code |
| `workspace-prs` | Workspace Pull Requests |
| `issue-statuses` | Issue Statuses (UI-only) |
| `open-prs` | Open Pull Requests |
| `pr-approve` | Approve Pull Request |
| `ask-pr-review` | Ask for PR Review |
| `issue` | Issue Card |
| `pr-reconcile` | Reconcile PR with Issue |
| `workspace-pr` | Workspace PR: gate, open, status |
| `status` | Werkmeister status |
| `check-in` | Check-in Triage |
| `workspace-usage` | Workspace Token Usage |
| `docker-ui` | Docker Container UI |
| `k8s-forwards-status` | k8s Forwards Health |
| `kube-context` | Current Kube Context |
| `kube-switch` | Switch Kube Context |
| `claude-transcript` | Claude Code Session Transcript |
| `claude-send` | Send to Claude Code Session |
| `claude-turn-status` | Claude Turn Status (UI-only) |
| `claude-resume` | Resume Claude Session in Terminal |

<!-- /generated -->

UI-only tools carry `_meta.ui.visibility: ["app"]`: the MCP App calls them, the
model does not see them.

**The App UI.** `create-workspace-form` and `list-workspaces` carry
`_meta.ui.resourceUri` (`ui://workspace/mcp-app.html`, `ui://workspace/mcp-list.html`).
A client that advertises the `io.modelcontextprotocol/ui` capability (Claude
Desktop) renders them inline; any other client gets the browser form
(`form-cli.js`) or a markdown table. The HTML is this app's vite build
(`mcp-app.html`, `mcp-list.html` and `ui/`, from `werkmeister-ui`), read from
`apps/werkmeister-mcp/dist`; the form is the dashboard's, from `apps/werkmeister-dashboard/dist`.
Both exist in a checkout only; a package install takes the text fallback.

## What is not here

`setup` and `config`, permanently: they mutate the host machine's install and a
remote client cannot repair a broken `~/.zshenv` by calling an API. `clean`,
`stats`, `optimize`, `cache` and `registry` are here since SW-184, for the
machine token only: `clean` deletes volumes across every feature, the wrong
blast radius for a workspace token.
