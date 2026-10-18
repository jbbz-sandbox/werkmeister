# sandbox

Turborepo monorepo (npm workspaces + [Turbo](https://turbo.build)).

## Workspaces

| App | Path | What |
| --- | --- | --- |
| `werkmeister` | [apps/cli](apps/cli) | Multi-feature concurrent development orchestrator CLI. |
| `sandbox-workspace-mcp-app` | [apps/sandbox-dashboard](apps/sandbox-dashboard) | MCP App + dashboard UI for creating/managing sandbox workspaces. |

| Package | Path | What |
| --- | --- | --- |
| `sandbox-core` | [packages/sandbox-core](packages/sandbox-core) | Shared library: config/registry resolution, workspace + issue-tracker helpers, typed wrappers over the CLI. |
| `vscode-plugin` | [packages/vscode-plugin](packages/vscode-plugin) | VS Code tree view over workspaces, container state and Telepresence intercepts. |

`sandbox-core` is the one shared dependency — the CLI, the dashboard and the VS
Code extension all read the same machine config through it. Only the CLI
publishes; everything else is private.

Every workspace here can also be run as a sandbox service of its own, so a feature
workspace can develop the sandbox inside the sandbox — see "Self-hosting the sandbox repo"
in [docs/users-guide.md](docs/users-guide.md).

## Install the CLI from a clone

To run the CLI you are developing, link the checkout onto your PATH:

```bash
git clone https://github.com/jbbz-sandbox/sandbox.git
cd sandbox
npm install && npm run build
npm link -w apps/cli       # puts `sandbox` on PATH, symlinked to apps/cli/sandbox
sandbox setup
```

The global `sandbox` is a symlink into this checkout, not a copy, so a rebuild
(`npm run build`) after a pull is all it takes to update it. `setup` records
this checkout as `sandbox_root`, so don't move or delete it while it is linked.
Until you rebuild, it keeps running the old bundle, so the CLI
prints a one-line stderr warning when `apps/cli/dist` was built from a
different commit than the checkout's `HEAD`. The warning names both SHAs and
the rebuild command, `npm run build --workspace sandbox-core && npm run build --workspace apps/cli`.
It never shows on a published install, which has no `.git`, and `sandbox hooks`
skips it. To skip the global link, run `./sandbox` from the repo root instead. To remove
the link, run `npm rm -g werkmeister`.

A linked CLI doesn't offer to install the VS Code extension. Only the published
package ships the `.vsix`, so build and install it yourself:

```bash
cd packages/vscode-plugin
npm run build && npm run package -- --out sandbox-workspaces.vsix
code --install-extension sandbox-workspaces.vsix --force
```

Linking replaces any registry install of the CLI, and the reverse is also
true. See the caveat at the end of the next section.

## Install the CLI without a clone

`werkmeister` is published to npmjs.com, so a machine that only needs to *run*
the CLI never has to clone this repo, and no token is needed. Install from
**outside** any checkout of this repo (see below):

```bash
cd ~
npx werkmeister setup    # installs globally, then runs the wizard
```

To check what's published, run `npm view werkmeister version`.

**Don't run the `npx` line inside a checkout of this repo.** npx prefers the
workspace link `node_modules/werkmeister → apps/cli` over the
registry, so it silently runs your checkout's CLI: nothing is installed,
`sandbox` stays off your PATH, and `setup` records the checkout as
`sandbox_root`.

That one command is the whole onboarding. npx only bootstraps: the wrapper sees
it is running from `~/.npm/_npx/<hash>/`, installs itself globally, and re-execs
the stable copy before doing any work. It has to — npm re-hashes and garbage-
collects that cache, while `setup` persists `sandbox_root` into
`~/.sandbox/config.yaml` and the compose generator bakes it into every
workspace's `compose.yml` as a bind mount. Running for real from the
cache would pin permanent state to a directory that is going to vanish.

`npm install -g werkmeister && sandbox setup` is the same thing
spelled out, if you would rather see the install happen. It is unaffected by the
current directory.

npm 11 warns that it skipped install scripts for `protobufjs`, `ssh2` and
`cpu-features` (`npm warn allow-scripts …`). Ignore it — don't allow them. All
three come in through `dockerode`: `protobufjs`'s only prints a version warning,
and the other two compile optional native add-ons used only for Docker over SSH,
which falls back to pure JS anyway. Allowing them just adds a `node-gyp` build
that needs Xcode's tools.

The package is a single esbuild bundle plus `infra/` — the templates, compose
files, proxy UI and skills the CLI reads at runtime. `sandbox-core` and the
CLI's other libraries are bundled in, so the only dependency npm resolves is
`dockerode`. `sandbox setup` still seeds `~/.sandbox` exactly as it does from a
checkout, which is what makes the two installs interchangeable. The headless
MCP server (`apps/mcp`) is bundled in too, as `dist/mcp.js`: `sandbox mcp`,
`sandbox connect`'s MCP server on 3002 and the `sandbox-tools` plugin's MCP
entry all work from the package. What stays checkout-only is the workspaces
dashboard (`apps/sandbox-dashboard`: issues, PRs, session and MCP-App UI tools);
`sandbox dashboard` falls back to the headless server where it is absent.

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
`werkmeister`, even for work that lives in `sandbox-core`:** the
description lands in the changelog of whichever package the changeset names, and
the CLI is the one anyone reads. `sandbox-core` is `fixed` to the CLI, so its
version follows either way.

On merge to `main`, the `release` job in `.github/workflows/ci.yml` opens (or
updates) a **"chore: version packages"** PR carrying the version bumps and
`CHANGELOG.md`. Merging *that* PR publishes to npmjs.com and tags the
release. So a release is one reviewable merge, and `main` never publishes by
accident.

`release` runs only after the same push's `test` job passes (`needs: test`), so
nothing publishes untested; npm will not accept a re-publish of a
version. The job publishes through npm trusted publishing (OIDC): npmjs.com
trusts `.github/workflows/ci.yml` in this repo, so no npm token is stored anywhere.

The version PR is pushed with a GitHub App's token so its own CI runs without
anyone approving it. The App needs Contents and Pull requests (read and write)
on this repo, no webhook; its ID goes in the repo variable `RELEASE_APP_ID` and
its private key in the secret `RELEASE_APP_PRIVATE_KEY`. Without them the job
falls back to `GITHUB_TOKEN`, and GitHub holds the version PR's CI until someone
approves it in the Actions tab.

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
and the service registry (generated from each repo's `.sandbox/services.yaml`),
then converges the rest: the `sandbox-tools` and
`ponytail` plugins, the companion `sandbox-workspace` checkout, a TLS
certificate covering every routed hostname, and the issue-tracker and
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
| `~/.sandbox/services.yaml` | Service registry — GENERATED from each repo's `.sandbox/services.yaml`; do not edit. |
| `~/.sandbox/services.local.yaml` | Per-machine registry overrides (`k8s_context`, …), merged last. |
| `~/.sandbox/ports.yaml` | Feature-slot port allocation. |
| `~/.sandbox/secrets.env` | Real credentials, as `<SERVICE>__KEY` or shared `KEY`. Each service gets the keys it declares in its own workspace `.env.<service>`. Never committed. |
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

The local cluster is set up from the **demo-services** repo, checked out
alongside this one under `paths.repos_root`:

```bash
cd ../demo-services
kubectl config use-context orbstack
./bin/bootstrap-k8s-env.sh   # shared infra: postgres + redis
./bin/deploy.sh              # the demo backend + frontend
```

Shared infra (postgres, redis) is deployed from there too — the sandbox
`k8s-forwards` container tunnels those Services into the docker world on the
ports the generated feature `.env` expects.
