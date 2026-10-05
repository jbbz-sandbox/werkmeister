# Generated runtime files move out of the CLI package into `~/.sandbox/infra`

**Date:** 2026-10-01
**Status:** approved in chat, spec written
**Follows:** the npm-package review of 2026-10-01 (`.changeset/mcp-in-package.md`
shipped its first batch: the bundled MCP server, the `dashboard` fallback, and
the skill fixes). This is the second batch.

## Goal

`sandbox connect` works from an `npm install -g` of `@jbbz-sandbox/sandbox-cli`
on any node prefix, and an `npm install -g` upgrade never deletes a file a
running container is bind-mounting. The CLI package directory becomes
read-only at runtime; everything the CLI generates lives under `~/.sandbox`,
next to the registry and the PID files that already live there.

## Problem

Five files are generated at runtime into the package's own `infra/` tree,
which on a global install is `<prefix>/lib/node_modules/@jbbz-sandbox/sandbox-cli/infra/`:

| File | Writer | Consumer |
|---|---|---|
| `infra/proxy/Caddyfile` | `generate.ts` `generateCaddyfile` | bind-mounted into `sandbox-caddy` (`shared-infra.yml:172`); `docker cp` on reload |
| `infra/proxy/ui/features.json` | same call | served by Caddy from the `../proxy/ui` dir mount (`:173`) |
| `infra/compose/k8s-port-forward/tmp/kubeconfig` | `infra.ts` `ensureProxyFiles` | bind-mounted into `k8s-forwards` (`:61`) |
| `infra/compose/k8s-port-forward/tmp/forwards` | `k8s_forwards.ts` `generateForwardsFile` | bind-mounted into `k8s-forwards` (`:63`) |
| `infra/compose/shared-infra.yml` (two `GENERATED` regions) | `k8s_forwards.ts` `regenerateSharedInfraForwards` | `docker compose -f` in seven call sites |

Consequences, in order of severity:

1. On a root-owned prefix (system node, `/usr/local/lib/node_modules`),
   `sandbox connect` fails with EACCES on the first write. The comment above
   `ensureProxyFiles` (`infra.ts:148`) already names this and names the fix.
2. `npm install -g` upgrades replace the package directory. The Caddyfile and
   kubeconfig a running container is mounting disappear until the next
   `connect`; a `docker compose restart` in between starts Caddy with a
   directory where its config should be (the `isDir` guards in `infra.ts`
   exist because Docker creates a directory for a missing bind source).
3. The two `tmp/` files are **committed to git** despite the module docstring
   saying the directory is gitignored (`git ls-files` lists both; the root
   `.gitignore` never mentions them). `tmp/kubeconfig` at `HEAD` carries
   `client-certificate-data` and `client-key-data`: a cluster client key is in
   the repository history. The `files` negation keeps it out of the tarball
   but not out of the repo.
4. `shared-infra.yml` is both shipped and mutated, so the installed package is
   never byte-identical to the published one, and `npm` cannot verify it.

## Decisions

Made 2026-10-01 in chat. The first two were the open questions; both take the
recommended default unless the review of this spec says otherwise.

- **D1. Location:** `~/.sandbox/infra/`, mirroring the shipped `infra/` layout
  one level down (`proxy/Caddyfile`, `proxy/features.json`,
  `k8s-port-forward/kubeconfig`, `k8s-port-forward/forwards`,
  `compose/k8s-forwards.override.yml`). It is the name `infra.ts:151` already
  proposes, and the shape lets a reader map every path back to the shipped
  tree. Derived from `sandboxHome()` so `SANDBOX_CONFIG_FILE` relocates it
  with everything else, as tests rely on.
- **D2. No automatic bounce.** `docker compose up -d` recreates any service
  whose mount sources changed, and `sandbox connect` already runs it. The
  first `connect` after upgrading therefore recreates `sandbox-caddy` and
  `k8s-forwards` on the new paths with no extra code. The release note says
  "run `sandbox connect` once after upgrading"; nothing else migrates.
- **D3. No migration copy.** All five files are regenerated from
  `~/.sandbox/*.yaml` and the live kubeconfig on every `connect`, so there is
  nothing in the old location worth carrying over. Stale copies under a
  checkout's `infra/` are left alone; `.gitignore` keeps ignoring them.
- **D4. `shared-infra.yml` stops being mutated.** The two `GENERATED` regions
  (`k8s-forwards` published `ports:` and network `aliases:`) move to a
  generated compose override file. The shipped file loses the regions and
  the markers.
- **D5. Shipped files stay in the package and are referenced absolutely.**
  The compose file's relative references to shipped content (`build.context:
  ./k8s-port-forward`, `./redisinsight/databases.json`, `../proxy/ui`) are
  resolved by Compose against the compose file's own directory, which stays
  in the package, so they do not change. Only the three generated-file
  mounts change, to `${SANDBOX_STATE_DIR}/...` interpolations.
- **D6. The tracked `tmp/` files are removed from git** (`git rm --cached`),
  the directory is gitignored, and the `!infra/compose/k8s-port-forward/tmp`
  negation in `package.json` `files` is dropped as redundant. Rotating the
  committed client credential is an operational action outside this change;
  this spec only flags it.

## Design

### 1. `stateInfraRoot()` in `sandbox-core/config.ts`

```ts
/** `~/.sandbox/infra`: everything the CLI generates for the shared infra. Read-only sibling: infraRoot(). */
export function stateInfraRoot(): string {
  return path.join(sandboxHome(), "infra");
}
```

`infraRoot()` keeps its meaning (the shipped tree: templates, skills, schemas,
compose sources, proxy UI) and its docstring gains one sentence pointing
here. Every writer below switches from `infraRoot()` to `stateInfraRoot()`;
every reader of a shipped file stays on `infraRoot()`.

### 2. One compose invocation helper

Six sites build `docker compose -f <infraRoot>/compose/shared-infra.yml`
by hand (`infra.ts` ×3, `caddy.ts`, `k8s.ts`, `status.ts`), and
`k8s_forwards.ts` resolves the same path to mutate it. They collapse onto one
export in `infra.ts`:

```ts
/** argv prefix + env for every `docker compose` call against the shared infra. */
export function composeInvocation(): { argv: string[]; env: NodeJS.ProcessEnv } {
  const files = [
    path.join(infraRoot(), "compose", "shared-infra.yml"),
    path.join(stateInfraRoot(), "compose", "k8s-forwards.override.yml"),
  ];
  return {
    argv: ["docker", "compose", ...files.flatMap((f) => ["-f", f])],
    env: { ...process.env, SANDBOX_STATE_DIR: stateInfraRoot() },
  };
}
```

`run()`/`runAsync()` already take `env` (`proc.ts:21`). The optional
`--env-file <sandboxRoot>/.env` branch in `composeCmd` is deleted: its own
comment says nothing creates that file. The override file must exist before
any compose call, including `status` and `down` on a fresh machine, so
`generateK8sForwards()` is called from `composeInvocation()` when the file is
absent. It is pure text from `services.yaml`, so this is cheap and cannot
loop.

### 3. `shared-infra.yml` changes

Three mounts change; the `GENERATED` regions and their marker comments go:

```yaml
# k8s-forwards
    volumes:
      - ${HOME}/.kube:/root/.kube:ro
      - ${SANDBOX_STATE_DIR}/k8s-port-forward/kubeconfig:/tmp/kubeconfig:ro
      - ${SANDBOX_STATE_DIR}/k8s-port-forward/forwards:/tmp/forwards:ro
# caddy
    volumes:
      - ${SANDBOX_STATE_DIR}/proxy/Caddyfile:/etc/caddy/Caddyfile:ro
      - ../proxy/ui:/sandbox/proxy/ui:ro
      - ${SANDBOX_STATE_DIR}/proxy/features.json:/sandbox/proxy/ui/features.json:ro
```

The last line is a file bind inside a directory bind, which Docker allows;
Caddy's `root * /sandbox/proxy/ui` + `file_server` block in `generate.ts`
needs no change. Under `k8s-forwards`, the `ports:` key is removed from the
shipped file outright (every entry in it today is generated), and `aliases:`
keeps only `k8s-forwards` itself.

### 4. The override file

`k8s_forwards.ts` replaces `renderSharedInfraForwards`/`regenerateSharedInfraForwards`
(and the `replaceBetween` marker machinery) with one renderer that writes
`~/.sandbox/infra/compose/k8s-forwards.override.yml`:

```yaml
# AUTO-GENERATED by `sandbox connect` from ~/.sandbox/services.yaml — do not edit.
services:
  k8s-forwards:
    ports:
      - "9052:9052"   # backend
    networks:
      shared-network:
        aliases:
          - k8s-backend
```

Compose merges `ports` and `aliases` lists by appending, so the shipped file
must not list the same entries, which D4 guarantees. `generateK8sForwards()`
writes this file and `k8s-port-forward/forwards`; both go through `mkdirSync`
on their parent. `generateForwardsFile(dest?)` keeps its injectable
destination for the existing tests.

### 5. Writers

| Site | Change |
|---|---|
| `generate.ts:1179` `generateCaddyfile` | `proxyDir = path.join(stateInfraRoot(), "proxy")`; `features.json` written to `proxyDir` directly (no `ui/` subdir). |
| `infra.ts:156-180` `ensureProxyFiles` | `root = stateInfraRoot()`; kubeconfig path drops the `compose/` and `tmp/` segments; `isDir` guards stay. Delete the ponytail comment above it. |
| `caddy.ts:324` `reloadProxy` | `hostCaddyfile` from `stateInfraRoot()`. |
| `k8s_forwards.ts` | as §4. Module docstring rewritten; it currently claims `tmp/` is gitignored. |
| `claude_md.ts:522-532` | the generated CLAUDE.md text names `$HOME/.sandbox/infra/proxy/features.json`. |
| `proxy_reload.ts:26` | message names the new path. |

Nothing reads the old locations afterwards; `grep -rn "proxy/Caddyfile\|k8s-port-forward/tmp\|proxy/ui/features" packages apps/cli/src` returning only `infraRoot`-free hits is the done check.

### 6. Plugin skills and docs

Four skills derive the Caddyfile path from the binary's location
(`SANDBOX_ROOT="$(dirname "$(readlink -f "$(command -v sandbox)")")"` then
`$SANDBOX_ROOT/infra/proxy/Caddyfile`): `sandbox-diagnose`, `sandbox-caddy-reload`,
`sandbox-routing-test`, `sandbox-status`. Each becomes
`CADDYFILE="${SANDBOX_CONFIG_FILE:+$(dirname "$SANDBOX_CONFIG_FILE")}"; CADDYFILE="${CADDYFILE:-$HOME/.sandbox}/infra/proxy/Caddyfile"`,
and the `SANDBOX_ROOT` derivation is dropped where that was its only use.
Docs that print the old path (`users-guide.md` ×6, `known-issues.md` ×8,
`troubleshooting-advanced.md` ×3) update to the new one; the historical
entries in `known-issues.md` that describe a past incident keep their text
and gain "(now `~/.sandbox/infra/proxy/Caddyfile`)".

### 7. Repository hygiene (D6)

- `git rm --cached apps/cli/infra/compose/k8s-port-forward/tmp/{kubeconfig,forwards}`
- `.gitignore`: add `apps/cli/infra/compose/k8s-port-forward/tmp/`; the two
  existing `apps/cli/infra/proxy/...` lines stay for checkouts that predate
  this change.
- `apps/cli/package.json` `files`: drop the `tmp` negation and shorten the
  `//files` comment, which exists mostly to explain it. The
  `!infra/proxy/Caddyfile` and `!infra/proxy/ui/features.json` negations
  also go: nothing writes there anymore.

### 8. Tests

- `generate.test.ts` redirects `infraRoot` into a tmp dir so the real
  Caddyfile is never written. It switches to redirecting `stateInfraRoot`
  (same `vi.hoisted` mock pattern) and asserts `features.json` lands in
  `proxy/`, not `proxy/ui/`.
- `k8s_forwards` gets one test: `renderK8sForwardsOverride(specs)` for two
  specs yields the YAML in §4 exactly, and the shipped `shared-infra.yml`
  contains no `GENERATED` marker (the drift test that used
  `renderSharedInfraForwards` becomes this).
- `composeInvocation()` gets one test under `SANDBOX_CONFIG_FILE` pointing at
  a tmp dir: both `-f` paths are present, `SANDBOX_STATE_DIR` is set, and the
  override file was created.
- Manual: from the unpacked-tarball layout used for the first batch, with
  `SANDBOX_CONFIG_FILE` in a tmp dir, `sandbox connect --k8s` writes only under
  that dir, and `ls -R <package>/infra` is unchanged before and after.

## Rollout

One changeset, `minor`, on `@jbbz-sandbox/sandbox-cli`. Release note: after
upgrading, run `sandbox connect` once; it recreates `sandbox-caddy` and
`k8s-forwards` on the new mount paths. Mention the credential in `tmp/kubeconfig`
history to the repo owner separately, not in the changelog.

## Out of scope

- Moving the ingress certificate (already under `~/.docker/certs` via
  `SANDBOX_CERTS_DIR`) or the registry files (already under `~/.sandbox`).
- Rewriting git history to purge the committed kubeconfig.
- The workspace compose template's `{{ sandbox_root }}/infra/compose/scripts/*-startup.sh`
  mounts: those are shipped files, correctly read from the package.
- The dashboard app's checkout-only status.
