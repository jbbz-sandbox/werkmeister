# Design: replacing the docker socket in the Werkmeister repo's containers (#135)

**Status:** proposed, awaiting the maintainer's decision. The registry is unchanged. Approving this
document is acceptance criterion 1 of [#135](https://github.com/jbbz-sandbox/werkmeister/issues/135); the
registry change ships in a separate PR afterwards.

## Problem

`cli`, `werkmeister-core`, `werkmeister-vscode` and `werkmeister-dashboard` all take `extra_volumes: *host_mounts`
from `.werkmeister/services.yaml`, and they run as root. The anchor gives them two separate ways out:

1. **The docker socket.** From inside `cli`, one command gives a privileged sibling container with
   the Mac's `/` and the user's `~/.ssh` mounted:

   ```text
   $ docker exec <ws>-cli sh -c 'docker run --rm --privileged -v /:/hostroot:ro -v "$HOME":/hosthome:ro node:22 \
       sh -c "grep CapEff /proc/self/status; ls /hostroot | head -3; ls -d /hosthome/.ssh"'
   CapEff:	000001ffffffffff
   Applications
   Library
   System
   /hosthome/.ssh
   ```

2. **Read-write host paths that the host later executes.** `~/repos`, `~/features` and
   `~/.werkmeister` are mounted read-write at their host paths. Code in the container can:
   - rewrite `~/repos/werkmeister/apps/cli/dist/main.js`, the host's own `werkmeister` build, which the
     host CLI and `apps/werkmeister-mcp` run;
   - edit `~/.werkmeister/env.sh`, which `apps/cli/werkmeister` sources on every host run;
   - add a hook under any `~/repos/*/.git/hooks`, or to any workspace's `.claude/settings.json`
     under `~/features`, which host Claude sessions run.

   Each of these is host-user code execution the next time the host runs the file. Removing only
   the socket leaves this way out open.

The code in these containers is untrusted by construction: agent sessions, the pre-PR gate's
`docker exec … sh -c '<test>'`, and every dependency's scripts.

## What the access is used for today

| Container | Uses host access for | Without it |
|---|---|---|
| `cli` | dogfood: the worktree's `werkmeister` driving the host daemon | its tests pass, apart from the `generate_certs` timeouts tracked in #178 (see Evidence) |
| `werkmeister-core` | `tsc --watch`; the #134 docker tests | its tests pass once one test skips without docker (see Evidence) |
| `werkmeister-vscode` | watch + tests; MCP client bed | its tests pass. The MCP route is HTTP to the host's `apps/werkmeister-mcp` and needs no socket |
| `werkmeister-dashboard` | its MCP tools call `werkmeister-core`, which shells out to docker, kubectl and the CLI | its tests pass. Tools that need the daemon have no `docker` binary in the container, so they move to the host (§ 3) |

The pre-PR gate is unaffected: `werkmeister pr gate` runs `docker exec` from the host.

## Recommendation: containers build and test, the host drives

Drop all of `&host_mounts` and `&host_env`. The four services become build/watch/test containers
like every other repo's services. The two uses that need the real daemon move to the host, where
the agent session already runs, using the worktree's own build.

### 1. Registry

Each of the four services keeps only what the compose generator gives every worktree service:
`/app` (the worktree), the `node_modules` volume, and the worktree's `.git/worktrees/<name>`
(read-only). The `tools` volume and the tools download in `werkmeister-install-startup.sh` go too.

```yaml
  cli:
    path: apps/cli
    # ... unchanged; no extra_volumes, no environment ...
    node_modules_volume: node-modules

  werkmeister-dashboard:
    # ... unchanged ...
    environment:
      HOST: 0.0.0.0        # the one &host_env key still needed, and only here
```

`werkmeister-vscode` keeps `secrets: [WERKMEISTER_MCP_TOKEN]` and its `mcp-client` archetype. It talks to
the host's `apps/werkmeister-mcp` over HTTP, which needs no mount at all.

### 2. Tests

- Add `packages/werkmeister-core/no-docker-socket.test.mjs`. It fails while any service in the <!-- docs-check: ignore -->
  repo's own `.werkmeister/services.yaml` mounts `docker.sock`, so the exception can't come back
  unnoticed. It was written and run in this run's reproduce stage, and it fails today with all
  four names.
- `workspace_init.test.mjs` "a non-interactive create with no strategy writes context_strategy:
  icm (#190)" runs the real `init-workspace`, which builds images. Give it the same
  `{ skip: !hasDockerCli() }` guard that `docker.test.mjs` already uses.

### 3. Dogfood and dashboard tools on the host

The worktree is already on the host (`~/features/<ws>/<repo>`). What the host lacks is a
`node_modules` for it: the container's tree lives in a docker volume, and the nested
`node_modules` on the bind mount hold linux binaries (for example
`apps/cli/node_modules/@esbuild/linux-x64`). A host `pnpm install` would replace those and break the <!-- docs-check: ignore -->
container's watcher.

The dependency tree can be borrowed instead of installed. A small host script builds a symlink
farm outside the worktree:
- every entry points into the installed checkout's `node_modules` (`~/repos/werkmeister`, darwin
  binaries);
- the workspace packages (`werkmeister-core`, …) point at the worktree's own `packages/`;
- the script runs the worktree's entry point with `--preserve-symlinks`.

This was run against the live daemon (see Evidence):
- **CLI.** The bundle's one runtime external is `dockerode`, so the worktree's
  `apps/cli/dist/main.js` drives the host daemon with nothing else. `werkmeister status` listed every
  feature with real container state.
- **Dashboard.** The worktree's `apps/werkmeister-dashboard/dist/main.js`, on top of the worktree's
  `werkmeister-core`, answered `workspace-status`, `kube-context` and `docker-ui` over stdio with real <!-- docs-check: ignore -->
  host state.

**Ceiling:** third-party dependency versions come from the installed checkout. A PR that changes
dependencies has to be dogfooded after `pnpm install` in the main checkout. The script should say so
when the worktree's and the installed checkout's `pnpm-lock.yaml` differ.

For the ICM pipeline this is the existing rule for every other repo: docker-dependent checks run
in the exercise stage, on the host.

**Residual risk:** dogfooding still runs the worktree's code with the daemon. That is what
dogfooding means. The container can still write the worktree (`/app`), so whatever it wrote runs
as the host user when the host dogfoods. The difference from today is when it runs:
- today: whenever any process in four containers decides to;
- under this design: only when the exercise stage chooses to, on a build it can diff first.

Rebuilding on the host right before the run (`node apps/cli/esbuild.mjs` with the borrowed tree)
narrows it to the committed source.

### 4. Docs

`docs/users-guide.md` "Self-hosting the Werkmeister repo" loses the "Host access" bullet. That bullet
is stale anyway: it names two services, but #137 gave access to four. It gains the host dogfood
script.

## Alternatives considered

| Option | Why not |
|---|---|
| Keep the exception for `cli` only | The escape is still one `docker run` away for anything that runs in `cli`, and the read-write host paths stay |
| Filtering docker API proxy (e.g. docker-socket-proxy) | An endpoint allowlist still lets `POST /containers/create` ask for `Privileged` or a `/` bind. Filtering request bodies makes the proxy a security boundary this repo has to own. And the compose files the CLI generates bind worktrees under `~/features` read-write, so the proxy has to allow the kind of bind behind the second escape |
| Container drives the host's `apps/werkmeister-mcp` with a token | Fine for an agent that operates Werkmeister (documented in `users-guide.md`), but `apps/werkmeister-mcp` runs the *installed* build, so it can't dogfood a worktree's changes |
| Docker-in-Docker / sysbox / rootless docker | dind needs `--privileged`, so it is another escape. sysbox is Linux-only, and rootless dockerd is not a drop-in under OrbStack or Docker Desktop. A second daemon also can't see the host's features, so the dogfood value is gone anyway |
| A VM with its own stack (`users-guide.md` shape 3) | The strongest isolation, but it is a second full install. Worth it for the agent itself, too heavy for four dev containers |

## Answers to the issue's open questions

- **Which design?** The one above: no daemon in the containers, and the host runs the worktree's
  build.
- **All four together, or keep an exception?** All four, in one PR. The anchor is shared, and
  the read-write paths make any one of them as dangerous as all four.
- **How does the `cli` dogfood path work without a daemon?** On the host, using the worktree's
  bundle and borrowed dependencies. Generated compose files carry host paths, so running on the
  host also removes the need to mirror paths into a container.
- **Stop running as root?** Not needed to close #135. Once the socket and the host paths are
  gone, root in the container reaches only `/app` and the `node_modules` volume. The registry has
  no `user:` field today (the compose generator would need one), so it belongs in a follow-up.

## Out of scope

- Infra containers outside the registry (Caddy, k8s-forwards) were not checked.
- Running the containers as non-root (above).
- Other repos' services: unchanged, and they never get the socket.

## Evidence

Measured on 2026-10-15 in workspace `sandbox-135-docker-socket-mount`, at `173ac96`. <!-- name-check: ignore -->

- **Four test suites without host access.** A throwaway `node:22` container with only the
  generator's mounts: no socket, no `docker` CLI, no `~/.werkmeister`, `~/.kube`, `~/repos` or
  `~/features`, running as root. Command:
  `npx turbo run test --force --continue --filter=werkmeister --filter=werkmeister-core --filter=werkmeister-vscode --filter=sandbox-workspace-mcp-app`.
  The first run, with all four suites at once, timed out across the CLI suite under machine load.
  So `werkmeister` and `werkmeister-core` were rerun alone. The baseline column is one run of all four
  suites at once, in today's `cli` container:

  | Suite | Without host access | Today's `cli` container (socket + host mounts) |
  |---|---|---|
  | `werkmeister-vscode` | 40 pass, 0 fail | 40 pass, 0 fail |
  | `sandbox-workspace-mcp-app` | pass | pass |
  | `werkmeister-core` | 456 pass, 2 fail: the new guard test (expected), and #190, which needs a `docker` CLI (§ Tests) | 457 pass, 2 fail: the new guard test, and `claude-md.test.mjs` "the active table is identical across work types", which reads the host's standards tree through the `~/.werkmeister` mount |
  | `werkmeister` | 421 pass, 2 fail: `generate_certs.test.ts` 5 s timeouts, the subject of #178 | 419 pass, 4 fail: 5 s and 30 s timeouts under load |

  Nothing in the CLI, plugin or dashboard suites needs the socket. Removing the host mounts also
  makes one werkmeister-core test hermetic.
- **Host dogfood:** `node <farm>/apps/cli/dist/main.js status` listed all six features with live
  container state.
- **Host dashboard:** with the farm and `--preserve-symlinks`, `workspace-status`, `kube-context` <!-- docs-check: ignore -->
  and `docker-ui` returned `isError=false` with real host state.
