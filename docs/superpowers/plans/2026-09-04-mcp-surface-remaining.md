# `apps/mcp` — Remaining Work Handoff

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Written 2026-09-04, to be read cold.** A session that has never seen the work
behind it should be able to execute from here.

**Goal:** Prove the `apps/mcp` surface actually does what it was built for — let
an agent in a container with **no Docker socket** drive the sandbox verbs.

**Spec:** `docs/superpowers/specs/2026-09-04-mcp-surface-design.md`
**Completed plan:** `docs/superpowers/plans/2026-09-04-mcp-surface.md` — read its
**Execution record** section first; it lists what was verified and what was not.

---

## Where things stand

`apps/mcp` is **built, reviewed, merged to `main` (`bbb0062`), and running.** 20
tools, bearer auth, `sandbox connect` lifecycle. Eight of nine spec §10
verification items pass.

**The server works and nothing is plugged into it.** Every check so far was
host-side. The one item that proves the branch's premise — §10.4, a container
with no socket — has never run, because three things are missing:

1. No socket-free container block exists in `~/.sandbox/services.yaml`.
2. No workspace is wired to the surface (deliberate — see Decision D1 below).
3. Therefore no container has ever called it.

### Verified working (don't re-litigate these)

- Server binds `*:3002`; dashboard stays `127.0.0.1:3001`. Per-app `env` on
  `WebApp`, proven with `lsof`.
- Auth: missing header 401, wrong token 401, any `Origin` 403, right token
  reaches the route (406 from the SDK when `Accept` lacks its two types — that
  is a pass, not a failure).
- `sandbox-up`, `sandbox-down`, `sandbox-logs`, `sandbox-test`,
  `sandbox-status`, `sandbox-services` all exercised against real features.
- Abort: client disconnect mid-`up` kills the compose child within ~4s.
- stdio purity: 35k chars of Playwright output landed in the tool result with
  stdout staying pure JSON-RPC.
- Per-workspace projection substitutes `${FEATURE}` and leaves
  `${SANDBOX_MCP_TOKEN}` literal.

---

## Decisions already made (binding unless you have a reason)

| # | Decision | Why |
|---|---|---|
| D1 | **`mcp_servers.sandbox` is in NO archetype.** | `.mcp.json` lives in the worktree, shared by host and container sessions. On the host, `host.docker.internal` does not resolve and `SANDBOX_MCP_TOKEN` is unset — wiring it into `node-web`/`node-tool` would write a permanently failing server into 4 of 6 existing workspaces. Add it per-workspace instead. |
| D2 | **Only `apps/mcp` binds `0.0.0.0`,** via a per-app `env` on its `WebApp`. | `web_servers.start()` passes one env to all three managed apps. A bare `HOST=0.0.0.0 ./sandbox connect` would expose the **unauthenticated** dashboard on every interface. Never do that. |
| D3 | **The token is never written into `.mcp.json`.** | That file is inside a git worktree and would be committed. `${SANDBOX_MCP_TOKEN}` is expanded by the MCP client from the container's environment. |

---

## Task 1: Give the socket-free container block a home

**The original plan's Step 4 is wrong and must not be copied.** It says to add
`extra_volumes: &mcp_client_mounts` / `environment: &mcp_client_env` "next to the
existing anchors on the `cli:` entry" — but `cli:` already has both keys
(`~/.sandbox/services.yaml:197` and `:204`). That is a duplicate key in one YAML
mapping.

**Files:** `~/.sandbox/services.yaml` — machine-global host config, **not in this
repo**. Back it up first.

- [ ] **Step 1: Back up**

```bash
cp ~/.sandbox/services.yaml ~/.sandbox/services.yaml.bak-$(date +%s)
```

- [ ] **Step 2: Add a top-level anchor block ABOVE `services:`**

YAML resolves anchors in document order, so this must appear before anything
aliases it. `services:` currently starts at line 38; put this just above it.
Only 7 top-level keys are read by the loaders (`services`, `setup_services`,
`infrastructure`, `repos`, `archetypes`, `mcp_servers`, `k8s_context` — see
`packages/sandbox-core/config.ts`), so an `x-`-prefixed key is ignored by all of
them. This follows the `x-host-access:` pattern the self-host design described
but never implemented.

```yaml
# A container that drives the sandbox through the host MCP surface (apps/mcp)
# instead of the daemon. The difference from the `cli:` entry's &host_mounts is
# the whole point of that surface: no /var/run/docker.sock, which is root on the
# host for anything that gets code execution in the container.
x-mcp-client:
  mounts: &mcp_client_mounts
    # Identical host paths: the agent edits code here, and generated compose
    # files on the host carry host paths.
    - /Users/jayboyer/repos:/Users/jayboyer/repos
    - /Users/jayboyer/features:/Users/jayboyer/features
  env: &mcp_client_env
    HOME: /Users/jayboyer
    GIT_CONFIG_COUNT: "1"
    GIT_CONFIG_KEY_0: safe.directory
    GIT_CONFIG_VALUE_0: "*"
    # Expanded into .mcp.json's Authorization header by the MCP client.
    SANDBOX_MCP_TOKEN: ${SANDBOX_MCP_TOKEN}
```

Deliberately absent, and why: `/var/run/docker.sock` (the mount this work
removes); `~/.sandbox` and `~/.kube` (the host server reads them); the `tools`
volume, `/opt/sandbox-tools/bin` on PATH and `DOCKER_CONFIG` (nothing in the
container runs docker or kubectl now); `/app/apps/cli` on PATH (the verbs arrive
as MCP tools); `HOST` (only a self-hosted *server* needs it).

- [ ] **Step 3: Verify the registry still loads**

```bash
cd /Users/jayboyer/repos/sandbox
node --input-type=module -e "
import { loadServices, loadArchetypes, loadMcpServers } from './packages/sandbox-core/dist/config.js';
console.log('services:', Object.keys(loadServices()).length);
console.log('mcp_servers:', Object.keys(loadMcpServers()));
console.log('archetypes:', JSON.stringify(loadArchetypes()));
"
```
Expected: services count unchanged (7), `mcp_servers` includes `sandbox`,
archetypes unchanged. A YAML parse error here means the anchor block is
malformed or misplaced.

- [ ] **Step 4: Resolve `SANDBOX_MCP_TOKEN`**

Unverified: whether the registry→compose generator passes `${…}` through for
docker compose to expand from the host environment. Test it — and if it does
not, use the secrets mechanism instead: add
`SANDBOX_MCP_TOKEN=<contents of ~/.sandbox/mcp-token>` to `~/.sandbox/secrets.env`
and `secrets: [SANDBOX_MCP_TOKEN]` to the service entry. A declared-but-missing
secret makes `sandbox up` refuse the workspace, which is the failure you want
rather than a container that silently 401s.

---

## Task 2: Wire one workspace and rebuild its container

- [ ] **Step 1: Pick or create a feature workspace** to drive from a container.
  `selfhost` (`~/features/selfhost`) is the existing self-host workspace and the
  natural candidate; a fresh one is cleaner if you want `selfhost` left alone.

- [ ] **Step 2: Point one service at the new anchors** — in that workspace's
  service entry in `~/.sandbox/services.yaml`, use
  `extra_volumes: *mcp_client_mounts` and `environment: *mcp_client_env` in place
  of `*host_mounts` / `*host_env`.

- [ ] **Step 3: Give that workspace the surface.** Per D1 this is per-workspace,
  not per-archetype. Either add `sandbox` to the `mcp_servers:` of an archetype
  only that workspace uses, or hand-add the `sandbox` entry to its `.mcp.json`.
  Then `cd <workspace> && sandbox init-workspace`.

- [ ] **Step 4: Confirm the projection**

```bash
python3 -c "
import json; d=json.load(open('<workspace>/.mcp.json'))['mcpServers']['sandbox']
print(d['url']); print(d['headers'])"
grep -cE '[0-9a-f]{64}' <workspace>/.mcp.json   # MUST be 0 — no literal token
```
Expected: `X-Sandbox-Feature` is that workspace's feature; `Authorization` is the
literal `Bearer ${SANDBOX_MCP_TOKEN}`; no 64-hex string anywhere in the file.

- [ ] **Step 5: Rebuild** — `sandbox down <feature> && sandbox up <feature>`.

---

## Task 3: Run spec §10.4 — the check this whole handoff exists for

- [ ] **Step 1: Prove the socket is gone.** From inside the container:

```bash
docker ps        # MUST fail — no socket, no docker CLI
```
If this succeeds, the block still carries the mount and nothing below proves
anything.

- [ ] **Step 2: Drive the verbs through the surface** — from the container's MCP
  client, call `sandbox-status`, then `sandbox-up`, `sandbox-logs` and
  `sandbox-down` against the container's own feature. All four must succeed, and
  `sandbox-status`'s feature list must reflect the up and then the down.

- [ ] **Step 3: Record the result** in the completed plan's Execution record
  table (§10.4 row) — pass or fail, with what you saw. Commit it.

### If Step 2 fails, read this before debugging

- **403 `Invalid Host`** → the server is on a loopback bind and the SDK's
  DNS-rebinding middleware is rejecting `Host: host.docker.internal:3002`. Check
  `lsof -nP -iTCP:3002 -sTCP:LISTEN` shows `*:3002`, not `127.0.0.1:3002`. This
  failure happens *before* any `apps/mcp` code, so the server log will be empty —
  it reads like an auth fault and is not one.
- **401** → the token. `${SANDBOX_MCP_TOKEN}` was not expanded in the container,
  or does not match `~/.sandbox/mcp-token`. See Task 1 Step 4.
- **Connection refused / timeout** → the macOS application firewall is enabled on
  this machine and blocks inbound to `node`. A LAN probe to the host's en0
  address times out for that reason. Whether it also affects Docker's
  `host.docker.internal` gateway route is **unknown and untested** — this is the
  one thing host-side testing could not tell us, and finding out is part of this
  task.

---

## Instruments

`sandbox status` reports the **dashboard** under `mcp_web_server`, not this
server. Until that is widened, use:

```bash
lsof -nP -iTCP:3002 -sTCP:LISTEN      # is it up, and on which address?
cat ~/.sandbox/sandbox-mcp.pid
tail ~/.sandbox/sandbox-mcp.log
ls -l ~/.sandbox/mcp-token            # must be 0600
```

Restart only this server, without bouncing the dashboard or claudeck:

```bash
node --input-type=module -e "
import { MCP, start, status } from './packages/sandbox-core/dist/web_servers.js';
import { ttyReporter, withReporter } from './packages/sandbox-core/dist/reporter.js';
await withReporter(ttyReporter, () => start(MCP));
console.log(JSON.stringify(await status(MCP)));
"
```

---

## Traps that already cost time

- **Never `pkill -f` a server here.** The cmdline is the cwd-relative
  `node dist/main.js`, which is byte-identical to `apps/sandbox-dashboard`'s. A
  narrow pattern matches nothing; a broad one kills the dashboard. This actually
  happened during the original work. Track PIDs, or use `lsof -ti tcp:<port>`.
- **A stale server on 3002 makes probes pass for the wrong reason.** The tell is
  a 406 where you expected a 401. Check the port is free before believing any
  result.
- **Each Bash tool call is a fresh shell.** A background `node … &` in one call
  is unreachable from the next; `kill %1` has no job. Do start/probe/cleanup in
  one invocation with a trap.
- **`sandbox_root` is machine-global.** Never run `sandbox config` or
  `sandbox setup` from a worktree — it silently repoints the whole machine.

---

## Known open items (from the final whole-branch review, all deliberate)

- **`statusSnapshot.mcp_web_server` reports the dashboard**, so neither
  `sandbox status` nor `sandbox-status` shows this server. Widening it changes a
  public result shape, which is why it was deferred.
- `apps/mcp/feature.test.mjs` imports the test fixture by cross-package relative
  path because `sandbox-core`'s `exports` map omits `fixtures.mjs`.
- `apps/mcp/tools.ts` — Task 8's imports sit in a second block rather than merged
  into Task 7's group. Cosmetic.
- The 20 registrations have no unit tests; they drive Docker, telepresence and
  browsers. §10.4 is their coverage — which is why it matters.
- **One unexplained test failure.** A single `turbo run typecheck build test
  --force` on the merged tree failed at `sandbox-core#test` (~16s in). Two later
  cold-cache full runs passed 15/15, and it never reproduced. No test this work
  added spawns a subprocess; the suite's three live-daemon smokes
  (`sandbox.smoke`, `compose-logs.smoke`, `docker.smoke`) are pre-existing and
  untouched. Plausibly a live-daemon smoke flaking under 15-way parallelism — a
  hypothesis, not a diagnosis. If you see it again, capture the output.
