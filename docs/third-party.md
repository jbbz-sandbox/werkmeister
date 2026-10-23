# Third-party software and licences

Every external library, program, container image and service Werkmeister depends on, with its licence. Werkmeister itself is Apache-2.0 ([LICENSE](../LICENSE), [NOTICE](../NOTICE)). Taken from the code at `werkmeister` 0.22.0 (SW-63). The npm part is enforced in CI by `pnpm run licenses` ([Checking npm licences](#checking-npm-licences)). The rest is checked by hand, so update this file whenever you add an image, a host command or an integration.

**Categories**

| Category | Meaning |
|---|---|
| bundled | inlined into a file Werkmeister publishes (`dist/*.js`, the .vsix). Werkmeister redistributes it, so its licence terms apply to us |
| installed | a runtime dependency of the `werkmeister` npm package. The user's npm downloads it from the registry; Werkmeister doesn't redistribute it |
| required | host software the person installs before Werkmeister works |
| dev-only | needed to build, test or release from a checkout. Never shipped |
| optional | an integration Werkmeister works without. The person opts in ([Optional integrations](#optional-integrations)) |

Versions: `range` is what package.json declares, `→ x.y.z` is what pnpm-lock.yaml resolves to.

## What the published package contains

`npm pack --dry-run` in `apps/cli`:

| Path | What it is |
|---|---|
| `dist/main.js`, `dist/lib/*.js`, `dist/mcp.js` | minified ESM bundles (esbuild, `apps/cli/esbuild.mjs`) of the CLI, the gate/hook entries and the MCP server. They inline `werkmeister-core`, `apps/werkmeister-mcp` and 115 npm packages |
| `dist/THIRD-PARTY-LICENSES.txt` | the name, version, licence and full licence text of each package inlined above. The build writes it from esbuild's metafile (packages that contribute bytes to an output) and fails if a bundled package has no licence file |
| `dist/LICENSE`, `dist/NOTICE` | copies of the repo's files, written by the same build |
| `dist/sandbox-workspaces.vsix` | the VS Code extension, built in `prepack` (see [vsix](#vs-code-extension-vsix)) |
| `infra/**` | compose files, Dockerfiles, nunjucks templates, JSON schemas, skills and a script |
| `bin/generate-certs.sh`, `werkmeister`, `w9r`, `sandbox`, `README.md`, `CONVENTIONS.md`, `package.json` | the wrappers and docs |

The minified bundles also keep the `/*! … */` licence banners some packages carry, because SW-58 left `legalComments` at its `eof` default. Most packages (commander, yaml, zod…) carry no such banner, so `THIRD-PARTY-LICENSES.txt` is where their required notice actually ships.

## npm dependencies

### Bundled into the CLI (`dist/*.js`)

These are the direct dependencies. All are devDependencies of `apps/cli`, or dependencies of the private workspaces it inlines, so none of them is installed at runtime. For the full transitive list, read `dist/THIRD-PARTY-LICENSES.txt` after a build. At 0.22.0 it holds 115 packages: MIT 102, ISC 10, BSD-3-Clause 2 (`fast-uri`, `qs`), BSD-2-Clause 1 (`nunjucks`).

| Package | Version | SPDX | Where used |
|---|---|---|---|
| commander | ^13.1.0 → 13.1.0 | MIT | CLI argument parsing (`apps/cli`) |
| @inquirer/prompts | ^8.5.2 → 8.5.2 | MIT | `setup` / interactive prompts (`apps/cli`) |
| yaml | ^2.9.0 → 2.9.0 | ISC | config and workspace files (`werkmeister-core`, `apps/cli`, dashboard) |
| nunjucks | ^3.2.4 → 3.2.4 | BSD-2-Clause | compose / Caddyfile / env templates (`werkmeister-core`) |
| ajv | ^8.20.0 → 8.20.0 | MIT | services-fragment schema validation in `detect` (`werkmeister-core/src/fragment_detect/validate.ts`) |
| jsonc-parser | ^3.3.1 → 3.3.1 | MIT | comment-preserving edits to VS Code settings in `setup` (`werkmeister-core/src/machine_setup.ts`) |
| tar-fs | ^2.1.5 → 2.1.5 | MIT | tar streams for the Docker API (`werkmeister-core/src/docker.ts`) |
| @modelcontextprotocol/sdk | ^1.30.0 → 1.30.0 | MIT | MCP server (`apps/werkmeister-mcp`, bundled as `dist/mcp.js`) |
| @modelcontextprotocol/ext-apps | ^1.7.0 → 1.7.4 | MIT | MCP App resources (`apps/werkmeister-mcp`) |
| express | ^5.1.0 → 5.2.1 | MIT | MCP HTTP transport (`apps/werkmeister-mcp`) |
| zod | ^4.4.3 → 4.4.3 | MIT | MCP tool schemas (`apps/werkmeister-mcp`) |

`dockerode` and its tree (`docker-modem`, `ssh2`, `cpu-features`, `@grpc/grpc-js`…) is **not** in the CLI bundle: it is an installed dependency (below).

`react`, `react-dom`, `@rjsf/*` and `markdown-it` are **not** in the published package either. They build into `apps/werkmeister-mcp/dist/*.html` and the dashboard, which only exist in a checkout, and `readAppHtml` (`apps/werkmeister-mcp/src/workspace_tools.ts`) only finds them there. Their category is **bundled (checkout builds only)**:

| Package | Version | SPDX | Where used |
|---|---|---|---|
| react, react-dom | ^19.2.8 → 19.2.8 | MIT | `werkmeister-ui` → MCP App HTML, dashboard |
| @rjsf/core, @rjsf/utils, @rjsf/validator-ajv8 | ^5.24.0 → 5.24.13 | Apache-2.0 | config forms in `werkmeister-ui` |
| markdown-it | ^14.3.0 → 14.3.2 | MIT | markdown rendering in `werkmeister-ui` |
| yaml, express, zod, MCP SDK + ext-apps | as above | as above | `apps/werkmeister-dashboard` server |

### VS Code extension (.vsix)

`packages/werkmeister-vscode/esbuild.mjs` inlines `werkmeister-core` and its dependencies into `extension.cjs` (CJS, not minified). The .vsix ships on its own and inside the npm package. Its bundled set, read from the sourcemap: dockerode 5.0.1, docker-modem 5.0.7, @balena/dockerignore 1.0.2, long 5.3.2 (Apache-2.0); protobufjs 7.6.5 and `@protobufjs/*`, bcrypt-pbkdf 1.0.2 (BSD-3-Clause); nunjucks (BSD-2-Clause); yaml, chownr, once, inherits, wrappy, split-ca (ISC); tweetnacl 0.14.5 (Unlicense); ssh2 1.17.0, cpu-features 0.0.10, jsonc-parser, tar-fs, tar-stream and the stream helpers (MIT). The build writes `LICENSE`, `NOTICE` and `THIRD-PARTY-LICENSES.txt` into the package root (`packages/werkmeister-vscode/`, gitignored), where vsce picks them up, using the same `scripts/write-licenses.mjs` as `apps/cli`. At 0.31.0 the file holds 47 packages, and vsce stores the root licence as `LICENSE.txt`. `split-ca` declares ISC but publishes no licence text, so its entry is a stub naming its source (`NO_LICENCE_FILE` in the script); any other bundled package without a licence file fails the build.

### Installed at runtime (`apps/cli` dependencies)

| Package | Version | SPDX | Where used |
|---|---|---|---|
| dockerode | ^5.0.1 → 5.0.1 | Apache-2.0 | Docker Engine API: containers, compose reads/stop/logs (`werkmeister-core`). Left external so npm resolves `ssh2`'s optional native `cpu-features` (`apps/cli/esbuild.mjs`) |
| … docker-modem 5.0.7 | | Apache-2.0 | dockerode transport |
| … @grpc/grpc-js 1.14.5, protobufjs | | Apache-2.0, BSD-3-Clause | dockerode's BuildKit session |
| … ssh2 1.17.0, cpu-features 0.0.10 (optional) | | MIT | dockerode's `ssh://` hosts |
| @anthropic-ai/claude-agent-sdk | ^0.3.288 → 0.3.288 | none (Anthropic Commercial Terms) | `detect --assist` only, loaded lazily (`apps/cli/src/lib/assist_resolver.ts`). Pulls a ~240 MB `claude-agent-sdk-<platform>` binary package and peer `@anthropic-ai/sdk` (MIT). See [Terms that need attention](#terms-that-need-attention) |

### Dev and build tooling

| Package | Version | SPDX | Where used |
|---|---|---|---|
| turbo | ^2.5.0 → 2.10.6 | MIT | task runner (root) |
| @changesets/cli | ^2.27.0 → 2.31.1 | MIT | versioning and publish (root, CI release job) |
| @biomejs/biome | 2.5.15 | MIT OR Apache-2.0 | lint/format (root) |
| esbuild | ^0.24.0 → 0.24.2 | MIT | CLI and extension bundles |
| vite, vite-plugin-singlefile | ^6.0.0 → 6.4.3, ^2.3.0 → 2.3.3 | MIT | MCP App / dashboard HTML |
| vitest | ^3.0.0 → 3.2.7 | MIT | CLI tests |
| quickpickle | ^1.11.2 → 1.11.2 | MIT | CLI Gherkin/BDD tests (`apps/cli/bdd`) |
| typescript | ^5.7 / ^5.9.3 → 5.9.3 | Apache-2.0 | all workspaces |
| tsx, concurrently, cross-env | → 4.23.1, 9.2.4, 10.1.0 | MIT | dev scripts |
| @vscode/vsce | ^3.2.0 → 3.9.2 | MIT | `vsce package`. Pulls `@vscode/vsce-sign` (Microsoft licence terms) |
| @vscode/test-electron, @vscode/test-cli | ^3.1.0 → 3.1.0, ^0.0.15 | MIT | extension integration tests. They download Microsoft's VS Code build (Microsoft Software License) into `.vscode-test/` |
| @types/* | | MIT | type definitions |

Transitive dev-only licences outside the usual set: Artistic-2.0 (vsce's `istextorbinary` family), WTFPL (`@azu/style-format`), CC-BY-3.0 (`spdx-exceptions`, a data file), Python-2.0 (`argparse`), BlueOak-1.0.0, 0BSD, CC0-1.0, Unlicense. `jszip` is `MIT OR GPL-3.0-or-later` and is taken as MIT.

## Required host software

The code checks only Node (via `engines`; the wrapper fails with "could not locate a node runtime") and Telepresence. The other minimums are what the docs and CI use.

| Software | Minimum | SPDX / terms | Used for |
|---|---|---|---|
| Node.js | `>=20` (`engines`). CI runs 24, the vscode image 22. Node 20 has been EOL since 2026-04 (follow-up 5) | MIT | runs `dist/main.js` |
| pnpm | contributors and CI only, via corepack (`packageManager: pnpm@10.34.7`) | MIT | install, `pnpm run build`, `pnpm publish` |
| npm | ships with Node (CI publish needs ≥11.5.1) | Artistic-2.0 | the upload `pnpm publish` hands it, npx bootstrap, users' `npm install -g` |
| Docker Engine | not checked. Reached through dockerode on `DOCKER_HOST` or the context socket | Apache-2.0 (Moby). Docker Desktop is proprietary (Docker Subscription Service Agreement) | every container |
| Docker Compose v2 plugin | not checked ("docker compose not found…" if absent) | Apache-2.0 | `docker compose` for features and shared infra |
| OrbStack (macOS, the default `k8s_context`) | not checked | proprietary (free for personal use, paid commercial licence) | Docker + local k8s on macOS. Any Docker Engine works for containers |
| git | not checked | GPL-2.0-only | worktrees, clone, commit/push, build stamp |
| Claude Code CLI (`claude`) | not checked; setup preflights `claude --version` | proprietary (Anthropic Commercial / Consumer Terms) | `setup` installs the plugins through it. Also used for refine, the Jira fallback and session send/resume |
| bash / sh | system | GPL-3.0-or-later (bash) | the `werkmeister`/`w9r`/`sandbox` wrappers, `generate-certs.sh` |
| openssl | system | Apache-2.0 (3.x); macOS ships LibreSSL (OpenSSL/ISC-style) | ingress cert (`bin/generate-certs.sh`), only with a `feature_router` |

## Host commands

Found by grepping for the process helpers: `run([…])`, `runCapture`, `runCmd`, `procRun` and `runner([…])` in `packages/werkmeister-core/src`; `spawn` / `execFile*` in `apps/*`, `packages/werkmeister-vscode/src` and `plugins/werkmeister/hooks`; and the shell scripts under `apps/cli/bin`, `apps/cli/infra` and `bin/`. To refresh the list:

    grep -rnoE '(run|runCapture|runCmd|procRun|runner|spawn|execFile|execFileSync)\(\s*\[?\s*"[a-z][a-z0-9_.-]*' apps packages plugins --include='*.ts' --include='*.tsx' --include='*.mjs' --exclude-dir=node_modules --exclude-dir=dist

| Command | Category | Where (main call sites) | SPDX / terms |
|---|---|---|---|
| git | required | `werkmeister-core/src/{worktrees,sandbox,pr_lifecycle,git_hooks,graduate,workspace_init,machine_setup}.ts`, `apps/cli/esbuild.mjs`, `build_freshness.ts` | GPL-2.0-only |
| docker (`docker compose`) | required | `werkmeister-core/src/{compose,compose_infra,lifecycle,pr_lifecycle,docker,caddy,infra}.ts` | Apache-2.0 |
| node, npm, npx | required | `web_servers.ts` (`node`; `pnpm run build` in a checkout), wrapper npx bootstrap, `test_run.ts` (`npx playwright`), `scaffold.ts` (`npx @upstash/context7-mcp` in generated MCP config) | MIT, Artistic-2.0 |
| claude | required for setup | `claude_cli.ts`, `machine_setup.ts`, `sandbox.ts` (`CLAUDE_BIN` override) | proprietary (Anthropic) |
| sh / bash | required | wrappers, `machine_setup.ts` (`bash generate-certs.sh`), `plugins/werkmeister/hooks/register.tsx` | GPL-3.0-or-later |
| openssl | feature | `apps/cli/bin/generate-certs.sh` | Apache-2.0 |
| sudo | feature | `generate-certs.sh` (trust cert, `/etc/hosts`); Telepresence | ISC |
| security (macOS) | feature | `infra.ts` (corporate CA), `generate-certs.sh` (`add-trusted-cert`) | Apple macOS component |
| osascript (macOS) | feature | `sandbox.ts` (resume Claude in Terminal) | Apple macOS component |
| open / xdg-open | feature | `apps/werkmeister-mcp/src/workspace_tools.ts`, `apps/werkmeister-dashboard/src/lib/localhost-form.ts`, `register.tsx` | Apple / xdg-utils (MIT) |
| lsof | feature, best effort | `web_servers.ts`, `pr_lifecycle.ts` | lsof licence (BSD-style) |
| ps | feature | `pr_lifecycle.ts` (close-out lists `claude` sessions) | system |
| kubectl | optional | `k8s.ts`, `sandbox.ts`, `fragment_detect/kustomize.ts`; also inside the k8s-forwards image | Apache-2.0 |
| helm | optional (`detect`) | `fragment_detect/helm.ts`; chart skipped when it fails | Apache-2.0 |
| gh | optional | `pr_lifecycle.ts`, `sandbox.ts`, `issue_trackers/github.ts`, `machine_setup.ts` (`SANDBOX_GH_BIN` override) | MIT |
| telepresence | optional | `telepresence.ts`, `machine_setup.ts` | Apache-2.0 (OSS client) |
| brew | optional | `machine_setup.ts` (Telepresence install) | BSD-2-Clause |
| launchctl / crontab | optional | `machine_setup.ts` (`pr watch` scheduler) | Apple macOS component / system cron |
| code | optional | `machine_setup.ts` (`--install-extension`), `sandbox.ts` (open workspace) | Microsoft Software License (VS Code); MIT (Code - OSS) |
| safaridriver | optional | `safari.ts` (`/usr/bin/safaridriver`) | Apple macOS component |
| Chrome / Chromium / Brave / Edge | optional | `browser.ts` (`CHROME_BIN`, `overrides.browser_path`, `overrides.browser`) | proprietary (Chrome, Edge); BSD-3-Clause (Chromium); MPL-2.0 (Brave) |
| werkmeister | — | spawned by the VS Code extension (`commands.ts`, through the `sandbox` wrapper) and the plugin's `.mcp.json` | Apache-2.0 |

## Container images

An image's licence covers its contents (base OS packages and the tool) and can differ from the tool's own licence. Contents marked † were read from the pinned image with `apk list -I` or the OCI `licenses` label.

| Image | Category | Where | Tool licence | Image contents licence |
|---|---|---|---|---|
| `caddy:2-alpine` (2.11.4 at time of writing) | required (shared infra) | `apps/cli/infra/compose/shared-infra.yml` | Apache-2.0 | label `Apache-2.0`†; Alpine base: musl MIT, busybox GPL-2.0-only, others mixed |
| `sandbox-k8s-forwards` (built `FROM alpine:3.21@sha256:48b0…`) | optional (k8s-forwards) | `infra/compose/k8s-port-forward/Dockerfile` | — (Werkmeister's entrypoint, Apache-2.0) | kubectl 1.31.5 Apache-2.0, bash 5.2.37 GPL-3.0-or-later, netcat-openbsd BSD-3-Clause, redis 7.2.11 BSD-3-Clause (`redis-cli`), postgresql17-client PostgreSQL, busybox GPL-2.0-only, musl MIT† |
| `jaegertracing/all-in-one@sha256:ab6f…` (pinned from `latest`) | optional (observability, on by default) | `shared-infra.yml` | Apache-2.0 | Apache-2.0 Go binary; base layers not inspected |
| `redis/redisinsight@sha256:aa21…` (pinned from `latest`) | optional (observability, on by default) | `shared-infra.yml` | **SSPL-1.0** (`/usr/src/app/redisinsight/LICENSE`†) | SSPL-1.0 app; base layers not inspected |
| `node:20.16.0` (feature default) / your `image:` | required per feature | `infra/templates/docker-compose.feature.yml.njk` | MIT (Node.js) | Docker Official Image on Debian: mixed (GPL, LGPL, MIT, …) |
| `node:22` + xvfb, xauth, GTK 3, NSS, … (SW-62) | dev-only | `packages/werkmeister-vscode/Dockerfile` | MIT (Node.js) | Debian packages: xvfb MIT/X11, GTK LGPL-2.1-or-later, NSS MPL-2.0, others mixed |
| Static docker 27.5.1, compose v2.32.4, kubectl v1.31.4 (downloaded into a tools volume) | dev-only (the sandbox repo's own services) | `infra/compose/scripts/sandbox-install-startup.sh` | Apache-2.0 ×3 | — |
| `alpine:3` (`detect` fallback guess) | — | `fragment_detect/precedence.ts` | — | Alpine: mixed |

Werkmeister pulls or builds these on the person's machine and doesn't redistribute them.

## Optional integrations

Werkmeister runs without each of these. The person turns one on.

| Integration | Enables | How to turn it on | When it's missing | Licence / terms |
|---|---|---|---|---|
| Jira (REST) | fast issue reads and updates, `issue create`, status moves | `jira.base_url`, `jira.email`, `jira.api_token` in `~/.werkmeister/config.yaml` (setup asks "Configure Jira credentials now?"). `overrides.issue_tracker` defaults to `jira` | setup reports "not configured". Reads fall back to `claude -p` over the Atlassian MCP. `issue create` fails with "no Jira REST credentials…" | Atlassian Cloud Terms of Service |
| GitHub Issues | tracker with `owner/repo#n` refs | `overrides.issue_tracker: github`, `overrides.github_org`, plus an authenticated `gh` | "not signed in" → `gh auth login`; "can't read <repo>" → `gh auth refresh -s repo`. A failed view returns no issue | GitHub Terms of Service |
| `gh` CLI | `pr open` / `status` / `watch` / `adopt`, PR review, default workspace repo | install and `gh auth login`. `SANDBOX_GH_BIN` overrides the binary | per-PR "gh pr view failed — …". `adopt` errors. Setup marks it optional | MIT (CLI); GitHub Terms of Service |
| kubectl + a cluster (k8s-forwards) | cluster services forwarded onto the Docker network | `k8s_context` in `~/.werkmeister/services.local.yaml` (default `orbstack`), then `werkmeister connect` | "Could not generate kubeconfig: …"; everything local still runs | Apache-2.0 (kubectl); the cluster's own terms |
| Telepresence | `werkmeister intercept` | setup step "Install/upgrade the OSS client via Homebrew" (`telepresenceio/telepresence/telepresence-oss`), then `bin/setup-telepresence-cluster.sh` once per cluster | setup ok "not installed (needed only for `sandbox intercept`)". Below `MIN_VERSION` 2.30.0, `intercept` refuses. `down` skips it | Apache-2.0 |
| Claude Code plugin (`plugins/werkmeister`): skills, `werkmeister mcp` server, Workspaces pane mod | in-session tools, the Workspaces pane | `werkmeister setup` installs it via `claude plugin`. The pane finds core through `WERKMEISTER_CORE_PATH` or `command -v werkmeister` | the CLI works alone. Without a UI build, App tools return text | Apache-2.0 (ours); Claude Code under Anthropic terms |
| Claude Desktop | MCP App UI in Desktop | manual `claude_desktop_config.json` entry (`plugins/werkmeister/README.md`) | hosts without App support get markdown | Anthropic Consumer / Commercial Terms |
| Cowork artifact | live dashboard artifact | `install-workspace-dashboard` skill (needs a checkout + `pnpm run build:ui`) | falls back to the Desktop MCP App | Anthropic terms |
| VS Code + extension | workspace and intercept tree view | setup prompt → `code --install-extension <bundled .vsix>` | "`code` not on PATH — skipped". A checkout bundles no .vsix | extension Apache-2.0; VS Code Microsoft Software License (Code - OSS MIT); `redhat.vscode-yaml` MIT for schema mapping |
| `pr watch` scheduler | resumes sessions when a PR merges, ships or closes | `werkmeister pr watch --install` or the setup prompt. macOS: launchd `com.werkmeister.pr-watch`. Elsewhere: a crontab line every 600s | not installed is fine. "launchctl bootstrap failed" / "crontab not found" when installing | Apple macOS component; cron (system) |
| Jaeger + Redis Insight | tracing UI and OTLP endpoints (16686/4317/4318); Redis UI (5540) | started with shared infra by `connect`. **No off switch today** (follow-up 4) | — (always on) | Apache-2.0; **SSPL-1.0** |
| Playwright + Chromium | `werkmeister test` | a `playwright.config` in the workspace or repo. Setup installs Chromium for `playwright@1.63.0` via npx | `test` exits non-zero and lists each service's test command | Apache-2.0 (Playwright); BSD-3-Clause (Chromium) |
| Browser for `werkmeister open` | a feature-tagged browser window | `overrides.browser` (default chrome), `overrides.browser_path`, `CHROME_BIN`; Safari needs `safaridriver --enable` | "Browser not found at …"; Firefox is refused as not Chromium | see Host commands |
| Homebrew | Telepresence install | installed by the person | "Homebrew not found — …" | BSD-2-Clause |
| Slack | dashboard "Request review" | `SANDBOX_REVIEW_SLACK_TOKEN`, `SANDBOX_REVIEW_SLACK_CHANNEL` | "Slack is not configured…" | Slack Terms of Service |
| Context7 MCP | docs MCP server in generated workspaces | archetype `mcp_servers` (`CONTEXT7_API_KEY`) | not configured | MIT (`@upstash/context7-mcp`); Upstash terms for the API |

## Terms that need attention

| Item | Finding | Recommendation |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | Not an OSI licence: "SEE LICENSE IN README.md" → Anthropic Commercial Terms. The platform package says "© Anthropic PBC. All rights reserved". Werkmeister doesn't redistribute it: esbuild keeps it external, and the user's npm fetches it from the registry under Anthropic's terms | Never bundle it. Move it to `optionalDependencies` so every install isn't charged ~240 MB for a flag few people use, and have `detect --assist` say how to install it when it's absent (follow-up 1) |
| Redis Insight image | SSPL-1.0, not OSI. Pulled, not redistributed. SSPL's obligations bite when you offer the software as a service, which local use doesn't do. But it starts for everyone with no off switch | Make it opt-in, e.g. a compose profile (follow-up 4) |
| `split-ca` in the .vsix | ISC by its `package.json`, but neither the npm package nor its repository carries a licence text, so the .vsix can only name it | It comes in through `docker-modem`. Ask upstream to add the text, or drop the dependency |
| OrbStack, Docker Desktop, Claude Code, Claude Desktop, VS Code (Microsoft build), Chrome | proprietary host software the person installs under its own terms | Fine. Werkmeister neither bundles nor requires the proprietary editions: any Docker Engine works, and Code - OSS / Chromium work where the code allows a path |
| `@vscode/vsce-sign` | Microsoft licence terms (use only with Visual Studio products). dev-only | Fine for packaging the extension. Listed in `REVIEWED` |
| `@vscode/test-electron` | downloads Microsoft's VS Code build for tests | Fine for CI and local tests. Don't redistribute `.vscode-test/` |
| WTFPL, CC-BY-3.0 (dev-only transitives) | not OSI, but permissive | Fine. Named in `REVIEWED` so a new non-OSI package still gets read by hand |

None of the bundled npm packages ships an Apache `NOTICE` file, so Werkmeister's [NOTICE](../NOTICE) only needs to name them and point at the licence texts.

## Checking npm licences

`pnpm run licenses` runs `scripts/check-licenses.mjs` (after its unit test). It runs in CI right after `pnpm install`, and it fails when any installed package has a licence outside the allowlist.

**Why this approach:** it reads `pnpm licenses list --json`, which pnpm builds from each installed package's own `package.json` (legacy `licenses` arrays included). It adds no dependency (`license-checker` is unmaintained), and fails CI the moment a dependency change lands. `pnpm-lock.yaml` carries no licences, so unlike the old `package-lock.json` reader it only sees what this platform installed: another platform's optional binaries (`@esbuild/darwin-arm64` and the like) aren't listed. Each is a twin of a listed package with the same terms; if one ever differs, run the check with pnpm's `supportedArchitectures` set to every platform. <!-- docs-check: ignore -->

**Policy:** `ALLOWED` lists permissive SPDX ids (OSI-approved, plus CC0-1.0). An `OR` expression passes if any branch is allowed, and an `AND` expression only if every term is. Anything else needs an entry in `REVIEWED`: the package name (platform packages `name-<platform>` match it) and why its terms are acceptable.

**When it fails:** read the package's terms. Then either add the SPDX id to `ALLOWED` (only for a permissive, OSI-approved licence) or add the package to `REVIEWED` with the reason, and update the tables above.

## How NOTICE was checked

At 0.22.0: build `apps/cli` (`npm run build`), run `npm pack --dry-run`, and compare three lists. The packages named in the `dist/*.js.map` sourcemaps (`sources` paths under `node_modules/`), the entries in `dist/THIRD-PARTY-LICENSES.txt`, and the licences NOTICE names (MIT, ISC, BSD-2-Clause, BSD-3-Clause) all agree. The tarball carries `dist/LICENSE`, `dist/NOTICE` and `dist/THIRD-PARTY-LICENSES.txt`, and the `/*!` banners SW-58 kept are still in `dist/mcp.js`. <!-- docs-check: ignore -->

## Follow-ups

1. Move `@anthropic-ai/claude-agent-sdk` to `optionalDependencies`, with a clear install hint from `detect --assist`.
2. ~~Ship LICENSE and third-party licence texts in the .vsix.~~ Done (SW-74).
3. ~~Remove `infra/compose/scripts/otel-init.bundle.js`, or restore its source and licences.~~ Resolved (SW-75): nothing referenced the bundle, so it was deleted.
4. Make Redis Insight (SSPL-1.0), and perhaps Jaeger, opt-in in shared infra.
5. Settle the Node floor: `engines` says `>=20` (EOL), the feature default image is `node:20.16.0`, and the ticket assumed 22.
