# Werkmeister

Werkmeister (formerly `sandbox`) is a multi-feature concurrent development orchestrator.
Its CLI is `werkmeister`, or `w9r` for short.

Turborepo monorepo (npm workspaces + [Turbo](https://turbo.build)).

## Workspaces

| App | Path | What |
| --- | --- | --- |
| `werkmeister` | [apps/cli](apps/cli) | Multi-feature concurrent development orchestrator CLI. |
| `werkmeister-mcp` | [apps/mcp](apps/mcp) | The one MCP server: every tool, over stdio and authenticated HTTP. Bundled into the CLI. |
| `werkmeister-dashboard` | [apps/sandbox-dashboard](apps/sandbox-dashboard) | The localhost dashboard and the MCP App UI bundles for creating/managing Werkmeister workspaces. |

| Package | Path | What |
| --- | --- | --- |
| `werkmeister-core` | [packages/sandbox-core](packages/sandbox-core) | Shared library: config/registry resolution, workspace + issue-tracker helpers, typed wrappers over the CLI. |
| `werkmeister-vscode` | [packages/vscode-plugin](packages/vscode-plugin) | VS Code tree view over workspaces, container state and Telepresence intercepts. |

`werkmeister-core` is the one shared dependency — the CLI, the dashboard and the VS
Code extension all read the same machine config through it. Only the CLI
publishes; everything else is private.

Every workspace here can also be run as a Werkmeister service of its own, so a feature
workspace can develop Werkmeister inside Werkmeister — see "Self-hosting the Werkmeister repo"
in [docs/users-guide.md](docs/users-guide.md).

## Install the CLI from a clone

To run the CLI you are developing, link the checkout onto your PATH:

```bash
git clone https://github.com/jbbz-sandbox/werkmeister.git
cd werkmeister
npm install && npm run build
npm link -w apps/cli       # puts `werkmeister` and `w9r` on PATH, symlinked into apps/cli
werkmeister setup
```

The global `werkmeister` is a symlink into this checkout, not a copy, so a rebuild
(`npm run build`) after a pull is all it takes to update it. `setup` records
this checkout as `sandbox_root`, so don't move or delete it while it is linked.
Until you rebuild, it keeps running the old bundle, so the CLI
prints a one-line stderr warning when `apps/cli/dist` was built from a
different commit than the checkout's `HEAD`. The warning names both SHAs and
the rebuild command, `npm run build --workspace werkmeister-core && npm run build --workspace apps/cli`.
It never shows on a published install, which has no `.git`, and `werkmeister hooks`
skips it. To skip the global link, run `apps/cli/werkmeister` from the checkout instead. To remove
the link, run `npm rm -g werkmeister`.

A linked CLI doesn't offer to install the VS Code extension. Only the published
package ships the `.vsix`, so build and install it yourself:

```bash
cd packages/vscode-plugin
npm run build && npm run package -- --out werkmeister-vscode.vsix
code --install-extension werkmeister-vscode.vsix --force
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
`werkmeister` stays off your PATH, and `setup` records the checkout as
`sandbox_root`.

That one command is the whole onboarding. npx only bootstraps: the wrapper sees
it is running from `~/.npm/_npx/<hash>/`, installs itself globally, and re-execs
the stable copy before doing any work. It has to — npm re-hashes and garbage-
collects that cache, while `setup` persists `sandbox_root` into
`~/.werkmeister/config.yaml` and the compose generator bakes it into every
workspace's `compose.yml` as a bind mount. Running for real from the
cache would pin permanent state to a directory that is going to vanish.

`npm install -g werkmeister && werkmeister setup` is the same thing
spelled out, if you would rather see the install happen. It is unaffected by the
current directory.

npm 11 warns that it skipped install scripts for `protobufjs`, `ssh2` and
`cpu-features` (`npm warn allow-scripts …`). Ignore it — don't allow them. All
three come in through `dockerode`: `protobufjs`'s only prints a version warning,
and the other two compile optional native add-ons used only for Docker over SSH,
which falls back to pure JS anyway. Allowing them just adds a `node-gyp` build
that needs Xcode's tools.

The package is a single esbuild bundle plus `infra/` — the templates, compose
files, proxy UI and skills the CLI reads at runtime. `werkmeister-core` and the
CLI's other libraries are bundled in, so the only dependency npm resolves is
`dockerode`. `werkmeister setup` still seeds `~/.werkmeister` exactly as it does from a
checkout, which is what makes the two installs interchangeable. The MCP server
(`apps/mcp`, every tool) is bundled in too, as `dist/mcp.js`: `werkmeister mcp`,
`werkmeister connect`'s MCP server on 3002 and the `werkmeister` plugin's MCP
entry all work from the package. What stays checkout-only is the workspaces
dashboard (`apps/sandbox-dashboard`): the localhost browser page and the MCP App
UI bundles, so on a package install the App tools answer in text.

One caveat if you keep both: `sandbox_root` is self-derived and last-writer-wins
in `~/.werkmeister/env.sh`, so whichever CLI you last ran `werkmeister config` from owns
that pointer. Pick one per machine.

### Releasing

Releases run on [Changesets](https://github.com/changesets/changesets); nobody
runs `npm publish` by hand. In a PR that changes anything user-visible:

```bash
npx changeset          # pick a bump, write a one-line description
```

That writes `.changeset/<name>.md` — commit it with the PR. **Name
`werkmeister`, even for work that lives in `werkmeister-core`:** the
description lands in the changelog of whichever package the changeset names, and
the CLI is the one anyone reads. `werkmeister-core` is `fixed` to the CLI, so its
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

The CLI's machine configuration lives in `~/.werkmeister`, not in this checkout —
it describes your machine (where your repos are, which services exist, which
hostnames the ingress terminates), so it is not something the repo can ship.
On a fresh clone, seed it before anything else:

```bash
npm install && npm run build
apps/cli/werkmeister setup            # guided wizard
```

The wizard walks through your repo/workspace paths, the ingress base domains,
and the service registry (generated from each repo's `.sandbox/services.yaml`),
then converges the rest: the `werkmeister` and
`ponytail` plugins (an old `sandbox-tools` install is swapped out; see
[Migrating from `sandbox-tools`](plugins/werkmeister/README.md#migrating-from-sandbox-tools)), the companion `sandbox-workspace` checkout, a TLS
certificate covering every routed hostname, and the issue-tracker and
Telepresence prerequisites. It is safe to re-run — nothing already configured
is overwritten.

```bash
apps/cli/werkmeister setup --check    # report drift; no prompts, no writes
apps/cli/werkmeister setup --yes      # non-interactive (CI); accepts defaults, skips optional installs
apps/cli/werkmeister pr watch --install   # schedule PR callbacks for terminal sessions (setup offers this)
```

`werkmeister up` will fail until `~/.werkmeister/services.yaml` exists, and will tell
you to run `werkmeister setup`.

| File | What |
| --- | --- |
| `~/.werkmeister/config.yaml` | Paths, ingress domains, optional Jira credentials — the single source of truth. |
| `~/.werkmeister/services.yaml` | Service registry — GENERATED from each repo's `.sandbox/services.yaml`; do not edit. |
| `~/.werkmeister/services.local.yaml` | Per-machine registry overrides (`k8s_context`, …), merged last. |
| `~/.werkmeister/ports.yaml` | Feature-slot port allocation. |
| `~/.werkmeister/secrets.env` | Real credentials, as `<SERVICE>__KEY` or shared `KEY`. Each service gets the keys it declares in its own workspace `.env.<service>`. Never committed. |
| `~/.werkmeister/env.sh` | Generated `SANDBOX_*` exports, sourced by `~/.zshenv` and the CLI wrapper. |
| `~/.werkmeister/corp-ca.crt` | Corporate TLS-proxy root(s), trusted by image builds. Auto-populated on macOS; see below. |

### Behind a TLS-intercepting proxy

On a corporate network that intercepts TLS (Netskope, Zscaler, Palo Alto), the
`k8s-forwards` image build fails: `apk add` can't verify the proxy-minted cert
served for `dl-cdn.alpinelinux.org`, and shared infra comes up degraded.

`werkmeister connect` handles this automatically on macOS — it extracts the proxy
root(s) from the System keychain into `~/.werkmeister/corp-ca.crt`, which the build
mounts as a BuildKit secret and appends to alpine's trust store. Off-proxy the
file is empty and the build is unchanged.

Auto-extraction matches a fixed list of vendor certificate names, so a vendor
outside that list — or a non-macOS host — needs the CA placed by hand:

```bash
# any PEM bundle; werkmeister never overwrites a file that already has a cert in it
cat /path/to/corp-root.crt > ~/.werkmeister/corp-ca.crt
apps/cli/werkmeister connect
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

The CLI launcher lives at [apps/cli/werkmeister](apps/cli/werkmeister). The old `sandbox` launcher ([apps/cli/sandbox](apps/cli/sandbox), also symlinked at the repo root as `./sandbox`) still works but is deprecated and goes away in SW-11.

## Local Kubernetes bootstrap

The local cluster is set up from the **demo-services** repo, checked out
alongside this one under `paths.repos_root`:

```bash
cd ../demo-services
kubectl config use-context orbstack
./bin/bootstrap-k8s-env.sh   # shared infra: postgres + redis
./bin/deploy.sh              # the demo backend + frontend
```

Shared infra (postgres, redis) is deployed from there too — the Werkmeister
`k8s-forwards` container tunnels those Services into the docker world on the
ports the generated feature `.env` expects.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
