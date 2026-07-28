# sandbox

Turborepo monorepo (npm workspaces + [Turbo](https://turbo.build)).

## Apps

| App | Path | What |
| --- | --- | --- |
| `sandbox` | [apps/cli](apps/cli) | Multi-feature concurrent development orchestrator CLI (TypeScript port). |
| `sandbox-workspace-mcp-app` | [apps/sandbox-dashboard](apps/sandbox-dashboard) | MCP App + dashboard UI for creating/managing sandbox workspaces. |

## First-time setup

The CLI's machine configuration lives in `~/.sandbox`, not in this checkout —
it describes your machine (where your repos are, which services exist, which
hostnames the ingress terminates), so it is not something the repo can ship.
On a fresh clone, seed it before anything else:

```bash
npm install && npm run build
./sandbox setup            # guided wizard
```

The wizard walks through your repo/workspace paths, the ingress base domains,
and the service registry, then converges the rest: the `sandbox-tools` and
`ponytail` plugins, the companion `sandbox-workspace` checkout, a TLS
certificate covering every routed hostname, and the optional Jira and
Telepresence prerequisites. It is safe to re-run — nothing already configured
is overwritten.

```bash
./sandbox setup --check    # report drift; no prompts, no writes
./sandbox setup --yes      # non-interactive (CI); accepts defaults, skips optional installs
```

`sandbox up` will fail until `~/.sandbox/services.yaml` exists, and will tell
you to run `sandbox setup`.

| File | What |
| --- | --- |
| `~/.sandbox/config.yaml` | Paths, ingress domains, optional Jira credentials — the single source of truth. |
| `~/.sandbox/services.yaml` | Service registry: repos, ports, k8s coordinates, ingress opt-in. |
| `~/.sandbox/ports.yaml` | Feature-slot port allocation. |
| `~/.sandbox/secrets.env` | Real credentials, injected into each feature's `.env`. Never committed. |
| `~/.sandbox/env.sh` | Generated `SANDBOX_*` exports, sourced by `~/.zshenv` and the CLI wrapper. |

Public hostnames are **derived**, not restated: a service that declares a
`feature_router:` block in `services.yaml` is served at
`<service>.<ingress.local_domain>`, and that one list drives the Caddy site
blocks, the certificate SANs and your `/etc/hosts` entries together. Set
`hostname:` on the service to override it.

## Commands

Run from the repo root — Turbo fans each task out across the workspaces that define it:

```bash
npm install        # install all workspace deps (one root node_modules)
npm run build      # turbo run build
npm run typecheck  # turbo run typecheck
npm run test       # turbo run test
npm run dev        # turbo run dev (dashboard watch/serve)
```

The `sandbox` CLI launcher lives at [apps/cli/sandbox](apps/cli/sandbox) (symlinked at the repo root as `./sandbox` for convenience).
