# `sandbox detect`: generate a repo's registry fragment

**Date:** 2026-10-02
**Status:** approved in chat, spec written

## Goal

`sandbox detect` in a repo that has never been onboarded writes a
`<repo>/.sandbox/services.yaml` fragment complete enough that
`sandbox registry sync && sandbox up` works without hand edits on a typical
repo. Single-service repos and monorepos are both handled. The command reads
what the repo already says about itself: package manifests, Dockerfiles,
docker-compose files, Helm charts, raw k8s manifests and kustomize overlays.

## Problem

Since 2026-10-01 (`2026-10-01-registry-fragments-design.md`) the registry is
generated from per-repo fragments, but every fragment is written by hand. The
three that exist (demo-services, mobile-app, sandbox) restate facts their repos
already hold: `containerPort` and `probePath` from the charts, `EXPOSE` and
`FROM` from the Dockerfiles, `dev` and `test` scripts from `package.json`, the
workspace layout from the root `package.json`. Onboarding a repo means
reading all of those and copying them over, then picking a `port_offset` that
no other repo uses.

The registry-fragments spec called the remaining fields "decisions a human
makes once". That still holds. This command makes the first draft of those
decisions, marks every one it guessed, and never overwrites one a human has
made.

## Scope

**In:**
- Node: npm, pnpm and yarn workspaces; turbo and nx.
- Any other stack: an entry built from its Dockerfile and deploy configs, with
  the command marked as a guess.
- Inputs: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `nx.json`,
  lockfiles, `Dockerfile*`, `docker-compose*.yml` / `compose*.yml`, Helm charts
  with `*.values.yaml` files, raw k8s manifests, kustomize.
- Optional Claude pass (Agent SDK) for the fields the deterministic pass can't
  settle.
- Replacing the old `sandbox detect` (changed-service detection), which no
  longer has a use.

**Out:**
- Full support for Python, Go and other stacks (no archetypes exist for them).
- Dev-environment configs: devcontainer, Skaffold, Tilt.
- Solving `port_offset` collisions across machines (`registry sync` already
  reports them).

## Design

The pipeline is: detectors → correlation → precedence → allocation →
(optional Claude pass) → render. Everything except the Claude pass is
deterministic: the same repo and the same other fragments give a
byte-identical result.

### 1. Detectors

Each detector is a pure function from the repo root and a file list to
`Fact[]`. A fact is `{ service, key, value, source, confidence }`:
- `source` is a file plus field, e.g. `charts/backend.values.yaml → containerPort`.
- `confidence` is `stated` or `guessed`; the Claude pass adds `inferred`.

Detectors don't depend on each other.

| Detector | Reads | Gives |
|---|---|---|
| workspace | root `package.json` `workspaces`, `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, the lockfile | The package directories, the package manager, and one shared install `setup_service` with `node_modules_volume`, using the same image as its services |
| package | each package's `package.json` | `path`; `command` = `cd <path> && exec <pm> run dev` (else `start`); `test`; `type`/`archetype` from dependencies |
| dockerfile | every `Dockerfile*` | `image` from the first `FROM`; `internal_port` from `EXPOSE`; a guessed `command` from `CMD` for services that aren't Node |
| k8s | YAML documents with `kind: Deployment`, `Service` or `Ingress`, plus the helm and kustomize output | `internal_port`, `health_endpoint`, `k8s_deployment`, `k8s_namespace`, `k8s_port`, `k8s_port_name`, `k8s_pod_prefix`, `memory_limit`/`memory_reservation`, `secrets`, `environment`, Ingress presence |
| helm | `Chart.yaml` directories paired with `*.values.yaml` files | `helm template <release> <chart> -f <values>` output, passed to the k8s detector. The release name is the values file's stem (`backend.values.yaml` → `backend`). Skipped with a warning when `helm` isn't installed. |
| kustomize | `kustomization.yaml` directories | `kubectl kustomize <dir>` output, passed to the k8s detector |
| compose | compose files | `environment`, `depends_on`, `command` and ports per service; datastore images become infrastructure candidates |

Details:
- `type`/`archetype` from dependencies:
  - `next`, `vite`, `react` or `expo` → `web` / `node-web`
  - `express`, `fastify`, `@nestjs/core` or `koa` → `api` / `node-service`
  - a `bin` field → `cli` / `node-tool`
  - none of these → `api` / `node-service`, guessed
- `image` comes from the first `FROM` because the build stage carries the
  toolchain a dev container needs; the final stage is often a slim runtime.

### 2. Correlation

**Anchors.** Every service is anchored to a source directory: a workspace
package directory, otherwise a directory containing a Dockerfile. A repo with
no workspaces and a root `package.json` or `Dockerfile` is a single-service
repo: `path: .`, and the repo's directory name as the service name.

**Names.** A service is named after its anchor directory's basename. When two
anchors share a basename, both become `<parent>-<basename>`. Scoped package
names are not used.

**Matching deploy-side facts to an anchor.** The first rule that matches wins:
1. The manifest file is inside the anchor directory.
2. A compose `build.context` resolves to the anchor directory.
3. A Helm release name, Deployment name or compose service name equals the
   service name.
4. The container image's repository name equals the service name
   (`backend:local`, `ghcr.io/org/backend`).

**Unmatched resources:**
- An image that is a known datastore (redis, postgres, mysql, mongo, rabbitmq)
  becomes an `infrastructure:` entry named after its Deployment or compose
  service. Its `health_endpoint` is the probe name (`redis`, `postgres`), or
  `""` for TCP-only.
- Anything else is reported as skipped, e.g.
  `found Deployment payments — no source dir in this repo, skipped`.

**Which packages qualify.** A workspace package becomes a service only if it
has a Dockerfile, a matching deploy-side fact, or a `dev`/`start` script.
Other packages are reported as skipped libraries. A library added by hand
(like the sandbox repo's `tsc --watch` packages) is kept on re-runs.

**Duplicates are expected.** The same resource can arrive from two sources
(demo-services has both `apps/backend/k8s.yaml` and `charts/webapp` +
`backend.values.yaml`). Both sets of facts attach to the one service, and
precedence decides per field.

### 3. Precedence

For each field the first source that has a value wins. A `guessed` value is
written with a `# guessed: <reason>` comment.

| Field | Order |
|---|---|
| `internal_port` | k8s/Helm `containerPort` → compose container port → Dockerfile `EXPOSE` → `3000` (guessed) |
| `health_endpoint` | `readinessProbe.httpGet.path` → `livenessProbe.httpGet.path` → compose `healthcheck` URL → `""` (TCP-only, guessed) |
| `image` | Dockerfile first `FROM` → `node:<major>` from `engines.node` or `.nvmrc` (guessed). See the note below. The k8s image is never used. |
| `command` | package `dev` → `start` → compose `command` → Dockerfile `CMD` (guessed) |
| `test` | package `test` script, run through the workspace (`npm test -w <pkg>`, `pnpm --filter <pkg> test`, `yarn workspace <pkg> test`); plain `npm test` in a single-service repo |
| `memory_limit`, `memory_reservation` | k8s `resources.limits` / `resources.requests`; omitted otherwise, so the template defaults apply |
| `depends_on` | compose `depends_on` |
| `feature_router` | `{}` when an Ingress targets the service (stated) or the service is `type: web` (guessed). `remote_upstream: k8s-<svc>:<k8s_forward_port>` only when the service has a forward port. |
| `secrets` | k8s `env[].valueFrom.secretKeyRef` names. Keys in `.env.example` are listed in a comment, not declared, because a declared secret that's missing makes `sandbox up` refuse to start. |
| `environment` | Merged per key, not first-wins: compose `environment` and k8s `env` values both contribute, and compose wins a key both set. A k8s value that addresses an infrastructure entry by its in-cluster host and port (`postgres:5432`) is rewritten to the tunnel address `k8s-<name>:<k8s_forward_port>` and marked guessed. |

Notes:
- **Image tag.** The fallback image uses `-alpine` unless a dependency ships
  glibc-only binaries (sharp, better-sqlite3, esbuild, @swc/core); the users
  guide records why.
- **Why the k8s image is never used.** It's the built app image, but the dev
  container runs the mounted source.
- **Conflicts.** When two `stated` sources disagree, the higher one wins and the
  loser is recorded as `# also: <value> (<source>)`. The command's report lists
  every conflict.

### 4. Allocation

`port_offset` indexes into `ports.yaml` `ports_per_slot`, which is 20 today,
so there are 20 offsets for the whole machine across all repos.

**Taken offsets** are the union of:
- `port_offset` values in every other repo's fragment under `repos_root`, read
  with `discoverFragments` rather than from the generated registry, so a repo
  that hasn't been synced yet still counts
- `services.local.yaml`
- this repo's existing fragment

**Allocation:**
- New services, in sorted name order, each get the lowest free offset.
- Infrastructure entries get the lowest free `k8s_forward_port` from 9050 up,
  checked against the same sources.
- When offsets run out, the command aborts and writes nothing:
  `port_offset exhausted: 20 offsets (ports.yaml ports_per_slot) are all used — raise ports_per_slot or free one`.

**Stable across re-runs.** Existing values are never changed, so offsets stay
put. The command prints a reminder that `port_offset` is machine-wide and that
a collision on another machine shows up at `registry sync`.

### 5. The command

```
sandbox detect [repo]              # default: git toplevel of the cwd
sandbox detect --dry-run           # report + proposed YAML, write nothing
sandbox detect --yes               # write without asking
sandbox detect --assist            # run the Claude pass without asking
sandbox detect --no-assist         # never run the Claude pass
```

**Report, in this order:**
1. Each service's fields, with value, source and confidence.
2. Conflicts.
3. Skipped items, with the reason.
4. For an existing fragment, only what would be added.

**Writing.** The command asks `Write <repo>/.sandbox/services.yaml? [y/N]`.
Without a terminal and without `--yes`, it behaves as `--dry-run`, the same
rule `setup` follows. After writing it prints `next: sandbox registry sync`;
it does not run the sync itself.

**Re-runs only fill gaps.** The existing file is edited through the `yaml`
package's `Document` API:
- Missing services and missing keys are added.
- Existing values, comments, anchors and `x-` blocks are untouched.
- Guessed, inferred and conflict comments are attached to their nodes.
- A new file gets the header comment the existing fragments share.

**Checks before writing.** The result must pass both:
- validation against `apps/cli/infra/schemas/services-fragment.schema.json`
- a test merge with `mergeRegistry` against the other repos' fragments

A failure aborts with nothing written.

**Errors:**
- A detector that throws (unparsable YAML, a chart that fails to render) puts
  that file on the skipped list with its error. The other detectors still run.
- Exhausted offsets, a schema failure or a merge failure abort the write.
- No services found: it says so and writes nothing.

### 6. Optional Claude pass

The deterministic pass produces the whole fragment. The Claude pass only
resolves items the deterministic stages flag as unsettled:

| Item | Why it's unsettled |
|---|---|
| `command` for a service that isn't Node | `CMD` is the production entrypoint; the dev command lives in a README, Makefile or task file |
| `environment` beyond the infrastructure rewrite | Which variables dev needs, from `.env.example`, config loaders, the README |
| `secrets` versus optional variables | Whether a missing key breaks the app or degrades it |
| `health_endpoint` with no probe | Whether a health route exists in the code |
| `depends_on` | Calls to another service's URL in the code |
| Unmatched Deployments; conflicts | Matching across different names; a precedence result that looks wrong |

**Mechanics.** One `@anthropic-ai/claude-agent-sdk` session, configured with:
- the repo as its working directory
- read-only tools only (Read, Glob, Grep; no Bash, Write or web)
- model `claude-opus-5-5`
- structured output, one answer per item: `{ item, value, reason, files_read }`

**Answers are constrained.**
- An answer for a field that isn't on the list is dropped.
- An answer never replaces a deterministic value or a value already in the
  file.
- Accepted answers are written with `# inferred by Claude: <reason>`, and the
  schema check and test merge still run.
- A failed, refused or invalid answer leaves the deterministic guess in place
  and is reported.

**When it runs.** Plain `sandbox detect` is deterministic. In an interactive
run with unsettled items, it asks
`N fields are guesses — ask Claude to resolve them? [y/N]`.
- `--assist` answers yes up front; `--no-assist` never asks.
- Non-interactive runs never call Claude without `--assist`.
- `--dry-run` shows the questions it would send.

**MCP.** The `sandbox-detect` MCP tool never starts a session: its caller is
already an agent. It returns the unsettled items in its report, and the caller
can supply answers on a second call with `write: true`. Those answers go
through the same constraints.

### 7. Code layout

- `packages/sandbox-core/fragment_detect/`
  - one file per detector: `workspace.ts`, `package.ts`, `dockerfile.ts`,
    `k8s.ts`, `helm.ts`, `kustomize.ts`, `compose.ts`
  - `correlate.ts`, `precedence.ts`, `allocate.ts`, `render.ts`, `assist.ts`
  - `index.ts`, exporting `detectFragment(repoRoot, { reposRoot, runner, resolver })`
- `helm` and `kubectl` go through the existing injectable `Runner`; the Claude
  pass goes through an injectable `Resolver`.
- `apps/cli/src/commands/detect.ts` is replaced by a thin wrapper.
- `apps/mcp/tools.ts`: `sandbox-detect` gets the new behaviour.

**Removed:**
- `packages/sandbox-core/detect.ts` and `detect-report.test.mjs`
- the old command's docs and its `known-issues` entry

## Testing

Tests are `node:test` files in `packages/sandbox-core` that run against
`dist/`. Fixture repos live under
`packages/sandbox-core/fixtures/fragment-detect/<case>/`. Each Helm and
kustomize fixture stores its rendered output, which the fake `Runner`
returns, so CI needs neither binary.

| Fixture | Checks |
|---|---|
| `single-node` | root `package.json` + `Dockerfile` → one service, `path: .`, named after the repo directory |
| `npm-turbo-helm` | trimmed copy of demo-services: shared install service, raw manifest and chart attaching to one service, redis/postgres as infrastructure, the `DATABASE_URL` rewrite |
| `pnpm-compose` | compose `environment`/`depends_on`, `build.context` matching, compose `redis` as infrastructure |
| `go-dockerfile` | a non-Node service from the Dockerfile, command marked guessed |
| `kustomize` | overlay rendered and read through the k8s detector |
| `library-skip` | `packages/utils` with no script or Dockerfile is skipped and reported |
| `conflict` | `containerPort 3000` vs `EXPOSE 8080`: k8s wins, `# also:` comment written |

**Behaviour tests:**
- **Gap-filling:** a fragment with hand comments, an `x-` anchor and a hand
  `environment` keeps every existing byte; only missing keys are added.
- **Idempotence:** a second run with nothing new is byte-identical.
- **Allocation:** the lowest gap is filled; with 20 offsets taken it aborts and
  writes nothing.
- **Collision:** a service name another repo already has fails the test merge
  before writing.
- **No `helm`:** the runner returns exit 127; charts are skipped with a warning
  and the Dockerfile still produces the entry.
- **Claude pass,** with a fake `Resolver`:
  - out-of-list answers are dropped
  - deterministic and existing values can't be overwritten
  - an invalid answer falls back to the guess
  - no test calls a real model
- **Real helm:** one test renders the real `charts/webapp` with `helm` when it's
  installed and skips otherwise, so the stored render can't drift.

**Acceptance check.** Before the work counts as done, run
`sandbox detect --dry-run` on demo-services and mobile-app and compare with their
hand-written fragments.
- Every field a file states must match.
- Differences are allowed only in judgement fields (`environment` beyond the
  rewrite, `secrets`, comments). The PR lists each one.

## Risks to resolve in the plan

- **Agent SDK auth.** Confirm against its documentation how the SDK picks up
  credentials (the Claude Code login versus `ANTHROPIC_API_KEY`) rather than
  assume.
- **Agent SDK bundling.** The SDK runs a bundled Claude Code binary, so it
  likely has to be `external` in `apps/cli/esbuild.mjs` and a real dependency
  of the npm package, as `dockerode` is. If that proves unworkable, the
  fallback is shelling out to `claude -p`, as `sandbox.ts` already does.
- **`helm template` needs.** Charts with remote dependencies need
  `helm dependency build` first. v1 renders without it and reports a chart
  that fails to render as skipped.
