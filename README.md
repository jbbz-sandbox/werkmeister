# sandbox

Turborepo monorepo (npm workspaces + [Turbo](https://turbo.build)).

## Apps

| App | Path | What |
| --- | --- | --- |
| `sandbox` | [apps/cli](apps/cli) | Multi-feature concurrent development orchestrator CLI (TypeScript port). |
| `sandbox-workspace-mcp-app` | [apps/sandbox-dashboard](apps/sandbox-dashboard) | MCP App + dashboard UI for creating/managing sandbox workspaces. |

## Install the CLI without a clone

`@jbbz-sandbox/sandbox-cli` publishes to GitHub Packages, so a machine that only
needs to *run* the CLI never has to clone this repo. Point npm at the registry
with a `read:packages` token, then install:

```bash
cat >> ~/.npmrc <<'EOF'
@jbbz-sandbox:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
EOF

export GITHUB_TOKEN=...                # see below — npm reads it from the env
npx @jbbz-sandbox/sandbox-cli setup    # installs globally, then runs the wizard
```

**`GITHUB_TOKEN` has to be set in the shell npm runs in.** npm expands it out of
the environment when it reads `~/.npmrc`; it does not consult the `gh` keyring,
so a machine where `gh auth login` works can still 404 on the install. Either
`export GITHUB_TOKEN=$(gh auth token)` (needs `read:packages` on that token —
`gh auth refresh -h github.com -s read:packages` adds it), or paste a classic PAT
with `read:packages`. The failure is a plain 404 that reads like the package does
not exist, not a permission error, so it is worth ruling out first.

That one command is the whole onboarding. npx only bootstraps: the wrapper sees
it is running from `~/.npm/_npx/<hash>/`, installs itself globally, and re-execs
the stable copy before doing any work. It has to — npm re-hashes and garbage-
collects that cache, while `setup` persists `sandbox_root` into
`~/.sandbox/config.yaml` and the compose generator bakes it into every
workspace's `docker-compose.yml` as a bind mount. Running for real from the
cache would pin permanent state to a directory that is going to vanish.

`npm install -g @jbbz-sandbox/sandbox-cli && sandbox setup` is the same thing
spelled out, if you would rather see the install happen.

The package is a single esbuild bundle plus `infra/` — the templates, compose
files, proxy UI and skills the CLI reads at runtime. `sandbox-core` and the
CLI's other libraries are bundled in, so the only dependency npm resolves is
`dockerode`. `sandbox setup` still seeds `~/.sandbox` exactly as it does from a
checkout, which is what makes the two installs interchangeable.

One caveat if you keep both: `sandbox_root` is self-derived and last-writer-wins
in `~/.sandbox/env.sh`, so whichever CLI you last ran `sandbox config` from owns
that pointer. Pick one per machine.

### Releasing

Releases run on [Changesets](https://github.com/changesets/changesets); nobody
runs `npm publish` by hand. In a PR that changes anything user-visible:

```bash
npx changeset          # pick a bump, write a one-line description
```

That writes `.changeset/<name>.md` — commit it with the PR. **Name
`@jbbz-sandbox/sandbox-cli`, even for work that lives in `sandbox-core`:** the
description lands in the changelog of whichever package the changeset names, and
the CLI is the one anyone reads. `sandbox-core` is `fixed` to the CLI, so its
version follows either way.

On merge to `main`, `.github/workflows/release.yml` opens (or updates) a **"chore:
version packages"** PR carrying the version bumps and `CHANGELOG.md`. Merging
*that* PR publishes to GitHub Packages and tags the release. So a release is one
reviewable merge, and `main` never publishes by accident.

The workflow re-runs `typecheck` and `test` before publishing. It duplicates CI on
purpose — both trigger on the same push, so CI is a race, not a gate, and GitHub
Packages will not accept a re-publish of a version.

`0.1.0` predates this and was published by hand from `main` at `7d77cf6`.

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
| `~/.sandbox/corp-ca.crt` | Corporate TLS-proxy root(s), trusted by image builds. Auto-populated on macOS; see below. |

### Behind a TLS-intercepting proxy

On a corporate network that intercepts TLS (Netskope, Zscaler, Palo Alto), the
`k8s-forwards` image build fails: `apk add` can't verify the proxy-minted cert
served for `dl-cdn.alpinelinux.org`, and shared infra comes up degraded.

`sandbox connect` handles this automatically on macOS — it extracts the proxy
root(s) from the System keychain into `~/.sandbox/corp-ca.crt`, which the build
mounts as a BuildKit secret and appends to alpine's trust store. Off-proxy the
file is empty and the build is unchanged.

Auto-extraction matches a fixed list of vendor certificate names, so a vendor
outside that list — or a non-macOS host — needs the CA placed by hand:

```bash
# any PEM bundle; sandbox never overwrites a file that already has a cert in it
cat /path/to/corp-root.crt > ~/.sandbox/corp-ca.crt
./sandbox connect
```

The symptom that this is what you're hitting: `docker compose build` failing on
`k8s-forwards` with a certificate verification error from `apk`.

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

## Local Kubernetes bootstrap

The cluster manifests (`charts/`) and their helper scripts now live in the
**demo-services** repo, checked out alongside this one under `paths.repos_root`:

```bash
cd ../demo-services
kubectl config use-context orbstack
./bin/bootstrap-k8s-env.sh   # shared infra: postgres + redis
./bin/deploy.sh              # the demo backend + frontend releases
```

Shared infra (postgres, redis) is deployed from there too — the sandbox
`k8s-forwards` container tunnels those Services into the docker world on the
ports the generated feature `.env` expects.
