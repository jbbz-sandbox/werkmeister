# Design — `apps/mcp`, the remote MCP surface for the sandbox verbs

**Date:** 2026-09-04
**Status:** approved in chat; not started
**Author:** Jay Boyer (decisions), Claude (drafting)
**Depends on:** `2026-09-04-command-logic-to-core-design.md` — this is the
surface its D1 deferred. That document is a prerequisite read, not a reference.

Written to be read cold. A session that has never seen the conversation behind
it should be able to execute from here.

---

## 1. The problem

`2026-09-03-self-host-services-design.md` made the sandbox repo run as sandbox
services, and it made the CLI work from inside a container by bind-mounting
`/var/run/docker.sock` and `~/.sandbox`, `~/repos`, `~/features` and `~/.kube`
at their identical host paths. That works, and it hands the container the host's
Docker daemon. Anything that gets code execution in that container gets the
daemon, and the daemon is root on the host.

The goal here is the same capability with that mount removed. An agent running
in an isolated container should be able to run the sandbox verbs — `up`, `down`,
`status`, `logs`, `test`, and the rest — without any Docker access at all,
by calling a **host-side MCP server** that holds the privilege and exposes only
the verbs.

`2026-09-04-command-logic-to-core-design.md` shipped the precondition. All 23
migratable verbs are now exported functions on `sandbox-core` with typed args,
typed results, `SandboxError` on failure, progress through the reporter, and
`AbortSignal` on the six that spawn or stream. Its §1 named this surface as the
consumer it was being built for. This document builds it.

---

## 2. Decisions

Made 2026-09-04 and binding.

| # | Decision | Rationale |
|---|---|---|
| D1 | **A separate app, `apps/mcp`, not more tools on `apps/sandbox-dashboard`.** | The dashboard is a UI-bearing MCP *App* for Claude Desktop on the host: it opens VS Code, launches Chrome windows, resumes terminal sessions, and binds loopback with no authentication. `apps/mcp` is headless, network-reachable from a container, and authenticated. One server cannot carry both trust levels honestly. |
| D2 | **Streamable HTTP with a bearer token.** | Reuses the transport the dashboard already runs and adds the authentication it lacks. The container reaches `http://host.docker.internal:3002/mcp`. |
| D3 | **Host-wide authority, feature resolved per request from a header.** | One container mounts all of `~/features`; the agent is opened in a feature directory and cwd decides the feature. The server cannot see the client's cwd, so the feature travels in `X-Sandbox-Feature`, pinned by the workspace's own generated `.mcp.json`. |
| D4 | **In-process calls into `sandbox-core`. No shelling out to the `sandbox` CLI.** | Every verb is a callable function as of the predecessor. Spawning the CLI would re-introduce the parse-the-output coupling that migration removed, and would make the surface depend on `apps/cli`. `apps/mcp` depends on `sandbox-core` alone. |
| D5 | **No command manifest** — the predecessor's D5, re-asked now that the surface exists, and answered the same way. | `main.ts`'s `SPECS` maps argv → args; the MCP layer maps JSON Schema → args. The only shared thing is a verb name and an args type, and TypeScript already checks both ends. A generator with two consumers costs more than twenty zod schemas in one file. Revisit at a third consumer, not before. |
| D6 | **`setup` and `config` are absent, permanently.** | Not a scoping choice: the predecessor's D3 excluded them from core and gave the reason — they mutate the host machine's install (`~/.zshenv`, `~/.sandbox/config.yaml`), and a remote client cannot repair a broken `~/.zshenv` by calling an API. There is nothing to expose. |
| D7 | **`clean`, `stats` and `optimize` are absent for now, reversibly.** | All three are callable. `clean` deletes orphaned volumes across *every* feature, not just the caller's, which is the wrong blast radius for a container-held token. `stats`/`optimize` are read-only and cheap to add later; they are out only because nothing needs them yet. |

---

## 3. Shape

New workspace `apps/mcp`, package name `sandbox-mcp`, `private: true`.

Headless. No vite, no `@modelcontextprotocol/ext-apps`, no HTML, no React —
those belong to the dashboard and are the bulk of its dependency tree.
Dependencies: `sandbox-core`, `@modelcontextprotocol/sdk`, `express`, `cors`,
`zod`. Built with plain `tsc`, like `sandbox-core`.

```
apps/mcp/
  main.ts          transport selection, auth middleware, abort wiring
  tools.ts         the twenty registrations
  lib/token.ts     read-or-create ~/.sandbox/mcp-token
  lib/feature.ts   header → feature, with the explicit-argument override
  package.json  tsconfig.json  README.md
```

Four source files. A fifth is a signal that a verb's logic is leaking back out
of `sandbox-core`; re-read §4 of the predecessor before adding one.

### Process lifecycle — reuse, do not rebuild

`packages/sandbox-core/web_servers.ts` already manages host daemons as `WebApp`
records with `start`/`stop`/`restart`/`status`/`isRunning`, PID and log files
under `~/.sandbox`, and staleness checks against a build artifact. `ALL` is what
`sandbox connect` brings up.

Add a third entry and the whole lifecycle comes for free:

```ts
export const MCP: WebApp = {
  label: "Sandbox MCP server",
  dir: "mcp",
  port: 3002,
  stem: "sandbox-mcp",
  entry: "dist/main.js",
  buildRef: "dist/main.js",
};
export const ALL: readonly WebApp[] = [DASHBOARD, CLAUDECK, MCP];
```

`stem` is `sandbox-mcp` and not `mcp-server`, which `DASHBOARD` already holds.
Port 3002 is free: the dashboard is 3001, claudeck 9009, and feature slots start
at 11100 (`getPortRange`).

No new lifecycle code, no new `sandbox` subcommand. `sandbox connect` starts it.

---

## 4. Transport, binding and authentication

`main.ts` mirrors the dashboard's two-mode entry point:

- `--stdio` — a host-local client (Claude Desktop, a host Claude Code session).
- default — Streamable HTTP at `POST/GET /mcp`.

**Binding.** `HOST` defaults to `127.0.0.1`. The container case sets
`HOST=0.0.0.0`, exactly as the self-host registry already does for the dashboard
(commit `228672e`), because the container network is the isolation boundary and
Docker's published port is the only way in.

**Token.** 32 random bytes, hex, in `~/.sandbox/mcp-token` at mode `0600`,
created on first start if absent. Every HTTP request must carry
`Authorization: Bearer <token>`; comparison is `crypto.timingSafeEqual` over
equal-length buffers, with a length check first. A missing or wrong token is
`401` with no body detail.

Required **whenever `HOST` is not a loopback address**. On a loopback bind the
token is still checked if present but a missing header is accepted, so a host
stdio/loopback client needs no configuration. The rule is a single predicate in
one place, not a per-route flag.

**CORS.** Reject any request carrying an `Origin` header, full stop. This server
has no browser UI, so unlike the dashboard it needs no localhost allowlist — the
absence of one is both less code and strictly safer. Same-origin and non-browser
clients send no `Origin` and are unaffected.

**Abort.** The predecessor's D4 put `signal?: AbortSignal` on exactly `up`,
`down`, `test`, `logs`, `intercept` and `connect`. For those six, `main.ts`
creates an `AbortController` per request and wires `res.on("close")` to
`abort()`, so a disconnecting client stops the work — the remote equivalent of
Ctrl-C, which is what D4 existed for. The other fourteen take no signal and get
no controller.

---

## 5. Feature resolution

One container, all of `~/features` mounted, and the agent opened in a feature
directory. The feature must therefore arrive over the wire.

`mcp_gen.ts` already projects a `.mcp.json` into each workspace root and already
owns a managed namespace of server names. The server entry it projects is:

```json
"sandbox": {
  "type": "http",
  "url": "http://host.docker.internal:3002/mcp",
  "headers": {
    "Authorization": "Bearer ${SANDBOX_MCP_TOKEN}",
    "X-Sandbox-Feature": "frontend"
  }
}
```

An agent started in that workspace loads that config, so every call is pinned
with no burden on the agent and no server-side session state to go stale.

**The token is never written into `.mcp.json`.** That file lives inside a git
worktree and would be committed. `${SANDBOX_MCP_TOKEN}` is expanded by the MCP
client from the container's environment, which the compose block supplies from
the host's token file.

**Server side.** `lib/feature.ts` reads `X-Sandbox-Feature`. Every tool that
takes a feature declares it as an *optional* argument defaulting to the header;
an explicit argument overrides. A call with neither is a `SandboxError` naming
both ways to supply it. The workspace *directory* is never a second header — it
is resolved from the feature by the existing `compose.workspaceForFeature` /
`resolveWorkspaceDir`.

### Feature substitution in `mcp_gen`

`writeWorkspaceMcp(workspaceRoot, serverNames, definitions)` writes each
definition body verbatim, so it cannot vary the feature per workspace. It gains
an optional `vars: Record<string, string>` parameter and substitutes `${NAME}`
in string values of the definition before writing. The caller passes
`{ FEATURE: <the workspace's FEATURE> }`.

Deliberately a dumb string substitution over the definition body rather than a
field the registry schema knows about: the registry stays free-form JSON, and
any future server that wants the feature gets it the same way.

`${SANDBOX_MCP_TOKEN}` is left alone by this pass — it is not in `vars`, and an
unmatched `${...}` is written through untouched for the MCP client to expand.

---

## 5b. The three changes required in `sandbox-core`

Everything else on the surface calls core unchanged. These three do not, and
each is a gap the migration left because it had no non-TTY consumer yet. All
three are small, and all three belong in core rather than being worked around
in `apps/mcp` — working around them would mean re-implementing in the adapter
exactly the orchestration the migration just moved out of the CLI.

**1. `mcp_gen.writeWorkspaceMcp` gains `vars`** — §5 above.

**2. `compose.composeLogs` gains `{ follow, tail }`.** It is hardcoded to
`logs -f --tail 100` and streams until the signal aborts. As an MCP tool that
never returns: the call hangs until the client disconnects, and the disconnect
is the only result. With `follow: false` it drops `-f` and returns when the
child exits; `tail` replaces the literal `100`. The CLI keeps today's behaviour
by passing `follow: true`, which is its default.

**3. `composeLogs` and `test_run.runFeatureTests` must honour `passthrough()`.**
Both call `runAsync` with no `capture`, and `proc.runAsync` maps that to
`stdio: "inherit"` — the child writes straight to this server's own stdout.
Under `--stdio` that stdout is the JSON-RPC transport, so a single `sandbox-test`
call corrupts the protocol stream; over HTTP the output is merely lost, since it
never reaches the collecting reporter and so never reaches the tool result.

The fix is the rule `reporter.passthrough()` was added to express and that
`workspace_init.ts:1003` already follows: pass `capture: !passthrough()`, and
emit the captured output through `raw()`. A TTY caller keeps inheriting stdio
and sees live Playwright output; a reporter-only caller gets the same bytes in
its transcript. `composeUpAsync`, `composeDownAsync` and `infra.up` already
hardcode `capture: true` and need nothing.

This is a correctness fix for any non-TTY consumer, not an `apps/mcp` special
case — claudeck and the dashboard have the same latent bug on these two paths.

---

## 6. Tool surface

Twenty tools, each prefixed `sandbox-` so they do not collide in an agent's tool
namespace. Every one is a thin adapter: validate with zod, call the core
function, return the result.

### Lifecycle and inspection (11)

| tool | core call | signal |
|---|---|---|
| `sandbox-up` | `lifecycle.up(feature, workspace, { signal })` | yes |
| `sandbox-down` | `lifecycle.down(feature, { removeVolumes, signal })` | yes |
| `sandbox-stop` | `lifecycle.stop(feature)` | |
| `sandbox-restart` | `lifecycle.restart(feature)` | |
| `sandbox-status` | `status.statusSnapshot()` + `interceptsSnapshot()` | |
| `sandbox-detect` | `detect.detectReport(...)` | |
| `sandbox-services` | `slots.featureServices(feature)` | |
| `sandbox-logs` | `compose.composeLogs(feature, service, { follow: false, tail, signal })` | yes |
| `sandbox-remove` | `lifecycle.removeService(feature, service)` | |
| `sandbox-test` | `test_run.runFeatureTests({ ..., signal })` | yes |
| `sandbox-proxy-reload` | `lifecycle.reloadProxy(...)` | |

`sandbox-logs` takes `service`, `tail` (default 200) and always passes
`follow: false`. It is a bounded read, not a subscription — see §5b item 2,
without which it would never return. The signal still covers a client that
disconnects mid-read.

### Workspace authoring (6)

| tool | core call |
|---|---|
| `sandbox-workspace` | `sandbox.createWorkspace(...)` |
| `sandbox-init-workspace` | `workspace_init.initWorkspace(...)` |
| `sandbox-skills` | `workspace_skills.checkSkills` / `syncSkills` |
| `sandbox-standards` | `standards.checkStandards()` |
| `sandbox-hooks` | `hooks_gen.writeWorkspaceHooks(workspaceRoot)` |
| `sandbox-notes` | `notes.buildContext` / `listNotes`, `graduate.graduateNote` |

`sandbox-workspace` binds to `sandbox.createWorkspace` — the non-interactive
path the dashboard already drives — not to `commands/workspace.ts`, whose wizard
is TTY-bound and stays in the CLI by §7 of the predecessor. Every input the
wizard would prompt for is a required or defaulted tool argument.

Likewise `sandbox-notes` exposes the pure half: `buildContext`, `listNotes`, and
`graduateNote` with the domain and kind supplied as arguments. The `readline`
resolvers stay CLI-side.

### Host-side (3)

| tool | core call | signal |
|---|---|---|
| `sandbox-connect` | `infra.up({ signal })` + `infra.connectK8s()` | yes |
| `sandbox-open` | `browser.launchFeatureWindow(...)` + `readWorkspaceYaml` | |
| `sandbox-intercept` | `telepresence.startIntercept` / `leaveIntercept` | yes |

These reach beyond the caller's own feature and have host-desktop side effects.
They are in because a container agent that cannot start shared infra or open a
browser window against its own feature is not actually doing the job — but they
are the widest blast radius on the surface and the first thing to gate if the
token's authority is ever narrowed.

### Absent

`setup` and `config` by D6 (nothing exists to call). `clean`, `stats` and
`optimize` by D7 (callable, deliberately not exposed yet).

---

## 7. Output contract

Every tool returns the same two things:

- **`content`** — the transcript the CLI would have printed for that verb,
  captured by wrapping the core call in `withReporter(collectingReporter(), ...)`
  and reading `.text()`. This is what makes the surface legible to an agent
  without the MCP layer re-implementing twenty renderers.
- **`structuredContent`** — the typed result the core function returned, verbatim.

This is the `{ command, output, path }` shape `sandbox.runWorkspaceAction`
already established for the dashboard, generalised. The reporter is
AsyncLocalStorage-scoped precisely so concurrent tool calls do not interleave
(`packages/sandbox-core/reporter.ts`, module docstring), so no per-call
correlation id is needed.

`passthrough` is **false** on this reporter. A child process must never inherit
this server's stdio — on `--stdio` that stdout is the JSON-RPC transport, and
the whole reporter indirection exists to prevent exactly that corruption.

**Errors.** A `SandboxError` becomes an MCP tool error whose message is the
error's message and whose `structuredContent` carries `{ code }`. The codes are
already meaningful (`NOT_RUNNING`, `WORKSPACE`, …) and are the remote analogue
of the CLI's exit codes. Anything else propagates as an internal error with the
transcript attached, because the transcript is usually the only diagnosis.

---

## 8. Container wiring

The compose block for a container that uses this surface differs from
`2026-09-03-self-host-services-design.md`'s host-access block in exactly one
way, which is the point of the work:

- **Removed:** the `/var/run/docker.sock` mount.
- **Kept:** `~/features` (and `~/repos`) at their identical host paths, because
  the agent edits code there and because generated compose files on the host
  carry host paths.
- **Added:** `SANDBOX_MCP_TOKEN`, read from `~/.sandbox/mcp-token`.
- **Unneeded now:** the docker CLI, the compose plugin, and `DOCKER_CONFIG` from
  the `tools` volume — nothing in the container runs docker any more. `kubectl`
  is separately useless from inside (see the known limitation below) and can go
  with them.

`~/.kube` and `~/.sandbox` need not be mounted at all: the host server reads
them.

---

## 9. Known limitations, carried forward

From the self-host proof, recorded in `docs/users-guide.md` and unchanged by
this work except where noted:

- **`status` k8s forwards and `kubectl` read the container's own loopback.**
  This surface *fixes* it: `sandbox-status` runs on the host, so its forward
  health is the real one. The limitation applies to a container running the CLI
  directly, not to a container calling this server.
- **Telepresence needs a root daemon on the host.** `sandbox-intercept` runs
  host-side, so it works — with the same authority a host terminal has, no more.
- **New hostnames need `/etc/hosts` entries**, reconciled by `sandbox setup`
  from the main checkout, which needs sudo. Not reachable from here by D6, and
  correctly so.

---

## 10. Verification

1. `npx turbo run typecheck build test` clean; `./sandbox standards check` clean.
   The output-preservation gate of the predecessor's §8 applies to §5b's three
   changes: `sandbox logs` and `sandbox test` must print the same bytes as before.
2. Server starts under `sandbox connect`; `~/.sandbox/mcp-token` created `0600`.
3. Loopback bind, no `Authorization` header → tools work. `HOST=0.0.0.0`, no
   header → `401`. Wrong token → `401`. Request with any `Origin` header → refused.
4. From a container with **no** docker socket: `sandbox-up`, `sandbox-status`,
   `sandbox-logs`, `sandbox-down` against its own feature all succeed, and
   `docker ps` inside the container fails.
5. `.mcp.json` projected into two different workspaces carries two different
   `X-Sandbox-Feature` values and no literal token.
6. A tool call with no `X-Sandbox-Feature` and no `feature` argument returns the
   error naming both ways to supply it; an explicit `feature` argument overrides
   the header.
7. Disconnect mid-`sandbox-up`: the compose child is killed, not orphaned.
8. `sandbox-test` and `sandbox-logs` under `--stdio`: the transcript arrives in
   the tool result and **nothing** reaches the server's stdout. This is the
   §5b item 3 regression test; without it the failure is a corrupted JSON-RPC
   stream, which does not look like a logging bug.
9. Agreement smoke, the same one the predecessor used: the host CLI's rendered
   `sandbox status` and this surface's `sandbox-status` describe the same facts.

---

## 11. Out of scope

- Any change to `apps/cli` beyond passing `follow: true` to `composeLogs`
  (§5b item 2), which preserves its current behaviour exactly. This surface is a
  second consumer of `sandbox-core`, not a rewrite of the first.
- Any change to `apps/sandbox-dashboard`, including consolidating its
  overlapping tools (`workspace-action`, `workspace-status`, `sandbox-connect`).
  The two servers overlap by design (D1); merging them is a separate question.
- A command manifest (D5).
- `setup` and `config` (D6); `clean`, `stats`, `optimize` (D7).
- Per-feature token scoping. The container holds all of `~/features`, so a
  feature-scoped token would be fiction. If the container topology changes to
  one-container-per-feature, revisit — the header-based resolution of §5 becomes
  a token claim with no other change to the surface.
- Reimplementing `docker compose`. Unchanged from both predecessors.
