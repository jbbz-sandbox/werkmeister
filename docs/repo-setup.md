# Setting up a repo for Werkmeister

A repo works with Werkmeister once it has a registry fragment,
`<repo>/.werkmeister/services.yaml`, and that fragment has been merged into
`~/.werkmeister/services.yaml`. This page walks through the steps and the mistakes that are
easy to make. The fields themselves are covered in the users guide:
[Writing a fragment](users-guide.md#writing-a-fragment) and
[Test commands and validation guidance](users-guide.md#test-commands-and-validation-guidance).

## Steps

1. **Clone the repo under `paths.repos_root`** (`~/repos` by default). The sync step only
   finds fragments there. Don't put extra worktrees of a repo there either, because each
   one would count as a second fragment declaring the same services.
2. **Draft the fragment:**

   ```bash
   werkmeister machine detect ~/repos/<repo> --dry-run   # check the report first
   werkmeister machine detect ~/repos/<repo>             # write it
   ```

   Every value it guessed has a `# guessed:` comment. Go through them all; see
   [What detect gets wrong](#what-detect-gets-wrong). You can also write the file by hand.
3. **Fix up the fragment** using the checklist below.
4. **Merge it into the registry:**

   ```bash
   werkmeister registry sync
   werkmeister registry --check   # "Registry is up to date."
   ```

   A duplicate service name or `port_offset` fails here and names both repos. If a repo
   doesn't show up, look for it in the disabled list in `~/.werkmeister/services.local.yaml`.
5. **Prove it runs:** create a workspace with the new services (`werkmeister workspace new`)
   and run `werkmeister feature up`. Then open `https://<service>.<local_domain>` for each
   service that has a `feature_router:`.
6. **Commit `.werkmeister/services.yaml`** to the repo.

## Checklist

- **`port_offset`:** must be unique across *all* repos. Find the ones in use with
  `grep -h port_offset ~/repos/*/.werkmeister/services.yaml`. Detect already picks a free one.
- **`internal_port`:** the port the dev server listens on *in the container*, not the
  port the app uses in production.
- **Bind to `0.0.0.0`.** Many dev servers listen on `localhost` only, which can't be
  reached from outside the container. For Vite: `vite --host 0.0.0.0 --port 5173`.
- **Allow the ingress hostname.** Vite (and other dev servers that check the `Host` header)
  turn away `<service>.<local_domain>` unless it's allowed: `server: { allowedHosts: true }`
  in `vite.config.*`. That's fine for a dev server only.
- **`health_endpoint`:** pick a path that returns 200 once the service is up, without a
  login. If the app's `/` needs a login or redirect state (such as an OAuth callback
  page), use another page.
- **`test:`:** an archetype's default can't run in every repo. `node-web` defaults to
  `npm test`, which fails in a package with no `test` script, and the pre-PR gate fails
  that service. Set a command that works, even if it's only the build
  (`pnpm --filter <pkg> build`).
- **`validate:`:** write how a person would check a change by hand, with
  `{{local_domain}}` in the URLs. Without it, agents are told there is no guidance.
- **`image:`:** detect reads the Node major from `engines`, so `>=22` gives `node:22`
  even if the repo is developed on 24. Pick the major you actually use.
- **pnpm in the container:** `node:*` images don't include pnpm. Start every command that
  calls it with `corepack enable &&`, and pin `packageManager` in the root `package.json`.
- **Give `node_modules_volume` a repo-specific name** (`<repo>-node-modules`, not
  `node-modules`; detect does this, but older fragments may not). The volume is per feature, not per repo, so in a workspace that checks
  out two repos, the same name puts both repos' installs in one volume and they break
  each other.
- **pnpm workspaces: put `node-linker=hoisted` in `.npmrc`.** Only `/app/node_modules`
  gets a volume. pnpm's default layout also writes a `node_modules` into each package,
  inside the bind-mounted worktree, where Linux installs from the container and macOS
  installs from the host overwrite each other, along with native binaries such as
  rollup's. Hoisted puts everything at the root, in the volume.
- **No install, no setup service.** A service with no dependencies can run `node` directly
  and leave out `setup_service` and `node_modules_volume`.
- **No `$schema:` key or `# yaml-language-server` line** in the fragment. See
  [Writing a fragment](users-guide.md#writing-a-fragment).

## What detect gets wrong

`werkmeister machine detect` reads `package.json`, Dockerfiles, compose files, Helm charts
and k8s manifests. A repo with none of the deploy files gives it little to go on. On a
pnpm + Vite + plain Node repo with no Dockerfile, it guessed:

| Field | Detect guessed | Right value |
|---|---|---|
| `internal_port` (Vite app) | `3000`, the default | `5173`, from the `dev` script's `--port` |
| `health_endpoint` | `""` (TCP only) | the app's real page, or `/health` |
| `image` | `node:22-alpine`, from `engines: >=22` | the Node major the repo is developed on |
| `test` (no `test` script) | not set, so the archetype's `npm test` applies | a command that can pass |

`--assist` asks Claude only about fields it can't read from a file, such as `depends_on`
and a non-Node service's command. It doesn't fix the guesses above. Re-running detect only
adds keys the file is missing, so your edits are kept.
