# Self-Host Sandbox Services Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register the sandbox repo's five workspaces as sandbox services so a feature workspace runs each in its own container, with a fully functional `sandbox` CLI inside the `cli` container.

**Architecture:** Registry-only for four of five services (the compose template already tolerates port-less watch loops); one shared `node:22` setup container installs, builds, and downloads the docker/compose/kubectl binaries into a per-feature volume; the three host-driving services bind-mount the docker socket and the host's `~/.sandbox`, `~/repos`, `~/features`, `~/.kube` at identical paths. One code fix makes the dashboard bind a configurable host.

**Tech Stack:** services.yaml (YAML anchors), docker compose via the existing nunjucks template, static docker/compose/kubectl binaries, TypeScript (one line).

**Spec:** `docs/superpowers/archive/specs/2026-09-03-self-host-services-design.md`

## Global Constraints

- Image is `node:22` (Debian) for the setup service and all five services. Never alpine.
- Port offsets: sandbox-core 2, cli 3, vscode-plugin 4, sandbox-dashboard 5, claudeck 6. Offsets 0 and 1 belong to demo-services.
- Host mounts use identical paths inside and outside: `/Users/jayboyer/.sandbox`, `/Users/jayboyer/repos`, `/Users/jayboyer/features`, `/Users/jayboyer/.kube` (ro), `/var/run/docker.sock`.
- Pinned tool versions: docker `27.5.1`, compose `v2.32.4`, kubectl `v1.31.4`.
- `~/.sandbox/services.yaml` is machine-local and not in git. Back it up before editing.
- Never run `sandbox config` or `sandbox setup` from a worktree. Run them from `~/repos/sandbox/apps/cli` (the main checkout) only.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: Dashboard binds a configurable host

**Files:**
- Modify: `apps/sandbox-dashboard/main.ts:23-28` and `apps/sandbox-dashboard/main.ts:73`

**Interfaces:**
- Produces: env var `HOST` (default `127.0.0.1`) read by `startHttp()`; Task 3 sets `HOST=0.0.0.0` in compose.

- [ ] **Step 1: Read `HOST` and use it for both the MCP app and the listener**

Replace lines 23-28 of `apps/sandbox-dashboard/main.ts`:

```ts
async function startHttp(): Promise<void> {
  const port = parseInt(process.env.PORT ?? "3001", 10);
  // Bind loopback by default: the tools this server exposes (Docker, VS Code,
  // kubectl, claude, workspace create/remove) are unauthenticated, so it must
  // never be reachable from the network. HOST=0.0.0.0 exists for one case: a
  // sandbox container, where the listener has to be reachable through Docker's
  // published port and the container network is the isolation boundary.
  const host = process.env.HOST ?? "127.0.0.1";
  const app = createMcpExpressApp({ host });
```

and line 73 `const httpServer = app.listen(port, "127.0.0.1", (err?: Error) => {` becomes:

```ts
  const httpServer = app.listen(port, host, (err?: Error) => {
```

- [ ] **Step 2: Build and run the check that fails without the change**

Run from `apps/sandbox-dashboard`:

```bash
npm run build:server && (HOST=0.0.0.0 PORT=3011 node dist/main.js & pid=$!; sleep 2; ss -ltn 2>/dev/null | grep 3011 || lsof -nP -iTCP:3011 -sTCP:LISTEN; kill $pid)
```

Expected: the listener line shows `*:3011` (all interfaces), not `127.0.0.1:3011`. Re-run without `HOST=` and confirm `127.0.0.1:3011`, proving the default is unchanged.

- [ ] **Step 3: Run the dashboard's own tests**

Run from `apps/sandbox-dashboard`: `npm test`
Expected: all smoke files exit 0 (they bind 127.0.0.1 themselves, so they are unaffected).

- [ ] **Step 4: Commit**

```bash
git add apps/sandbox-dashboard/main.ts
git commit -m "fix(dashboard): honor HOST so the listener is reachable through a published Docker port"
```

---

### Task 2: Setup startup script that installs docker, compose, and kubectl into the tools volume

**Files:**
- Create: `apps/cli/infra/compose/scripts/sandbox-install-startup.sh`

**Interfaces:**
- Consumes: the compose template mounts `<sandbox_root>/infra/compose/scripts/<setup_name>-startup.sh` at `/usr/local/bin/startup.sh` when a setup service sets `startup_script: true`.
- Produces: `/opt/sandbox-tools/bin/{docker,kubectl}` and `/opt/sandbox-tools/docker/cli-plugins/docker-compose` in the per-feature `tools` volume. Task 3 puts `/opt/sandbox-tools/bin` on `PATH` and sets `DOCKER_CONFIG=/opt/sandbox-tools/docker`.

- [ ] **Step 1: Write the script**

```sh
#!/bin/sh
# Installs the host-facing CLIs the sandbox repo's own services need into the
# per-feature `tools` volume mounted at /opt/sandbox-tools. Runs from the
# sandbox-install setup container (services.yaml `startup_script: true`).
# Idempotent: each download is skipped when its binary already exists, so a
# re-up of the same feature costs nothing.
set -eu

TOOLS=/opt/sandbox-tools
DOCKER_VERSION=27.5.1
COMPOSE_VERSION=v2.32.4
KUBECTL_VERSION=v1.31.4

ARCH="$(uname -m)" # x86_64 | aarch64 — docker/compose name assets this way
case "$ARCH" in
  x86_64) KARCH=amd64 ;;
  aarch64) KARCH=arm64 ;;
  *) echo "sandbox-install: unsupported arch $ARCH" >&2; exit 1 ;;
esac

mkdir -p "$TOOLS/bin" "$TOOLS/docker/cli-plugins"

if [ ! -x "$TOOLS/bin/docker" ]; then
  curl -fsSL "https://download.docker.com/linux/static/stable/$ARCH/docker-$DOCKER_VERSION.tgz" \
    | tar -xz -C "$TOOLS/bin" --strip-components=1 docker/docker
fi

if [ ! -x "$TOOLS/docker/cli-plugins/docker-compose" ]; then
  curl -fsSL -o "$TOOLS/docker/cli-plugins/docker-compose" \
    "https://github.com/docker/compose/releases/download/$COMPOSE_VERSION/docker-compose-linux-$ARCH"
  chmod +x "$TOOLS/docker/cli-plugins/docker-compose"
fi

if [ ! -x "$TOOLS/bin/kubectl" ]; then
  curl -fsSL -o "$TOOLS/bin/kubectl" "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/linux/$KARCH/kubectl"
  chmod +x "$TOOLS/bin/kubectl"
fi

"$TOOLS/bin/docker" --version
DOCKER_CONFIG="$TOOLS/docker" "$TOOLS/bin/docker" compose version
"$TOOLS/bin/kubectl" version --client
```

- [ ] **Step 2: Run it in a throwaway `node:22` container**

```bash
chmod +x apps/cli/infra/compose/scripts/sandbox-install-startup.sh
docker run --rm -v "$PWD/apps/cli/infra/compose/scripts/sandbox-install-startup.sh:/usr/local/bin/startup.sh:ro" node:22 sh /usr/local/bin/startup.sh
```

Expected: the last three lines print `Docker version 27.5.1`, `Docker Compose version v2.32.4`, and a kubectl `Client Version: v1.31.4` line. Run it twice in the same container to confirm the second run downloads nothing:

```bash
docker run --rm -v "$PWD/apps/cli/infra/compose/scripts/sandbox-install-startup.sh:/usr/local/bin/startup.sh:ro" node:22 sh -c 'sh /usr/local/bin/startup.sh >/dev/null && time sh /usr/local/bin/startup.sh'
```

Expected: second run completes in under a second.

- [ ] **Step 3: Commit**

```bash
git add apps/cli/infra/compose/scripts/sandbox-install-startup.sh
git commit -m "feat(infra): startup script installing docker/compose/kubectl into a feature tools volume"
```

---

### Task 3: Register the services in `~/.sandbox/services.yaml`

**Files:**
- Modify: `~/.sandbox/services.yaml` (machine-local, not in git)

**Interfaces:**
- Consumes: `HOST` from Task 1; `startup.sh` from Task 2.
- Produces: services `sandbox-core`, `cli`, `vscode-plugin`, `sandbox-dashboard`, `claudeck`; setup service `sandbox-install`; repo `sandbox`; archetype `node-tool`. Task 5 selects these by name.

- [ ] **Step 1: Back up the registry**

```bash
cp ~/.sandbox/services.yaml ~/.sandbox/services.yaml.bak-2026-09-03
```

- [ ] **Step 2: Add the `node-tool` archetype**

Under the existing `archetypes:` key, after `node-web`, add:

```yaml
  # Build/test-only packages: no listener, no UI standards.
  node-tool:
    standards: [engineering, testing]
```

- [ ] **Step 3: Add the five services**

Append under `services:` (after `frontend`). The `cli` entry defines the YAML anchors; `sandbox-dashboard` and `claudeck` alias them, so `cli` must stay above them in the file. The loader is the `yaml` package, which resolves anchors but not `<<` merge keys, which is why the shared `environment:` block carries `HOST=0.0.0.0` for all three.

```yaml
  # --- The sandbox repo's own workspaces (self-hosting) -----------------------
  # All five share one repo bind mount at /app and one per-feature node_modules
  # volume; sandbox-install populates it and builds sandbox-core/dist first.
  # The three watchers have no listener: the template still publishes a port
  # and its healthcheck is `curl … || exit 0`, so they read healthy anyway.
  sandbox-core:
    repo: sandbox
    path: packages/sandbox-core
    type: library
    archetype: node-tool
    test: "npx turbo run test --filter=sandbox-core"
    internal_port: 3999
    port_offset: 2
    health_endpoint: /
    setup_service: sandbox-install
    image: node:22
    command: "cd packages/sandbox-core && exec npx tsc --watch --preserveWatchOutput"
    memory_limit: 512M
    memory_reservation: 128M
    node_modules_volume: node-modules

  # Fully functional CLI: the host's docker socket plus ~/.sandbox, ~/repos,
  # ~/features and ~/.kube mounted at their host paths, because the compose
  # files it generates carry host bind-mount paths and the daemon is the
  # host's. HOME matches so `~` expands the same way; PATH puts the worktree's
  # own `sandbox` wrapper first (the dogfood point) and the tools volume next.
  # GIT_CONFIG_* marks every directory safe: the worktrees belong to the host
  # uid, and git refuses "dubious ownership" otherwise.
  cli:
    repo: sandbox
    path: apps/cli
    type: cli
    archetype: node-tool
    test: "npx turbo run test --filter=@jbbz-sandbox/sandbox-cli"
    internal_port: 3998
    port_offset: 3
    health_endpoint: /
    setup_service: sandbox-install
    image: node:22
    command: "cd apps/cli && exec npm run watch"
    memory_limit: 512M
    memory_reservation: 128M
    node_modules_volume: node-modules
    extra_volumes: &host_mounts
      - /var/run/docker.sock:/var/run/docker.sock
      - /Users/jayboyer/.sandbox:/Users/jayboyer/.sandbox
      - /Users/jayboyer/repos:/Users/jayboyer/repos
      - /Users/jayboyer/features:/Users/jayboyer/features
      - /Users/jayboyer/.kube:/Users/jayboyer/.kube:ro
      - tools:/opt/sandbox-tools
    environment: &host_env
      HOME: /Users/jayboyer
      PATH: /app/apps/cli:/opt/sandbox-tools/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
      DOCKER_CONFIG: /opt/sandbox-tools/docker
      GIT_CONFIG_COUNT: "1"
      GIT_CONFIG_KEY_0: safe.directory
      GIT_CONFIG_VALUE_0: "*"
      # Read by sandbox-dashboard (Task 1); harmless for the others.
      HOST: 0.0.0.0

  vscode-plugin:
    repo: sandbox
    path: packages/vscode-plugin
    type: library
    archetype: node-tool
    test: "npx turbo run test --filter=vscode-plugin"
    internal_port: 3997
    port_offset: 4
    health_endpoint: /
    setup_service: sandbox-install
    image: node:22
    command: "cd packages/vscode-plugin && exec npm run watch"
    memory_limit: 512M
    memory_reservation: 128M
    node_modules_volume: node-modules

  # Serves the workspace dashboard + MCP endpoint; its tools shell out to the
  # CLI, docker and kubectl, so it gets the same host access as `cli`.
  sandbox-dashboard:
    repo: sandbox
    path: apps/sandbox-dashboard
    type: web
    archetype: node-web
    test: "npx turbo run test --filter=sandbox-workspace-mcp-app"
    internal_port: 3001
    port_offset: 5
    health_endpoint: /
    setup_service: sandbox-install
    image: node:22
    command: "cd apps/sandbox-dashboard && exec npm run dev"
    memory_limit: 1G
    memory_reservation: 256M
    node_modules_volume: node-modules
    extra_volumes: *host_mounts
    environment: *host_env
    # dashboard.local.sandbox.com — local only; nothing runs in the cluster.
    feature_router: {}

  # Claude Code web UI; chat needs the Anthropic key, the workspace plugin
  # needs the same host access as `cli`.
  claudeck:
    repo: sandbox
    path: apps/claudeck
    type: web
    archetype: node-web
    test: "npx turbo run test --filter=claudeck"
    internal_port: 9009
    port_offset: 6
    health_endpoint: /
    setup_service: sandbox-install
    image: node:22
    command: "cd apps/claudeck && exec node server.js"
    memory_limit: 1G
    memory_reservation: 256M
    node_modules_volume: node-modules
    secrets: [ANTHROPIC_API_KEY]
    extra_volumes: *host_mounts
    environment: *host_env
    # claudeck.local.sandbox.com — local only.
    feature_router: {}
```

- [ ] **Step 4: Add the setup service and repo mapping**

Under `setup_services:` add:

```yaml
  # The sandbox repo's install + build + tools download. `npm run build` runs
  # so sandbox-core/dist exists before the five services start; startup.sh
  # (infra/compose/scripts/sandbox-install-startup.sh) fills the `tools`
  # volume with docker/compose/kubectl for the host-access services.
  sandbox-install:
    repo: sandbox
    image: node:22
    command: "npm install && npm run build && sh /usr/local/bin/startup.sh"
    node_modules_volume: node-modules
    startup_script: true
    extra_volumes:
      - tools:/opt/sandbox-tools
```

Under `repos:` add:

```yaml
  sandbox:
    services: [sandbox-core, cli, vscode-plugin, sandbox-dashboard, claudeck]
    path_mappings:
      packages/sandbox-core: sandbox-core
      apps/cli: cli
      packages/vscode-plugin: vscode-plugin
      apps/sandbox-dashboard: sandbox-dashboard
      apps/claudeck: claudeck
```

- [ ] **Step 5: Verify the anchors resolve and the CLI reads the registry**

```bash
node -e 'const y=require("yaml"),fs=require("fs");const d=y.parse(fs.readFileSync(process.env.HOME+"/.sandbox/services.yaml","utf8"));console.log(d.services.claudeck.extra_volumes.length, d.services.claudeck.environment.HOST, Object.keys(d.services).join(","))' 
cd ~/repos/sandbox/apps/cli && ./sandbox services
```

Expected: `6 0.0.0.0 backend,frontend,sandbox-core,cli,vscode-plugin,sandbox-dashboard,claudeck`, and `sandbox services` lists all seven without error. If `sandbox services` rejects `type: library` or `type: cli`, change both to `api` and note it in the users-guide section (Task 6).

- [ ] **Step 6: Confirm the Anthropic key exists**

```bash
grep -c '^ANTHROPIC_API_KEY=.\+' ~/.sandbox/secrets.env
```

Expected: `1`. If `0`, `sandbox up` will refuse the workspace with "Missing required secret(s)"; add the key to `~/.sandbox/secrets.env` before Task 5.

---

### Task 4: Regenerate the ingress certificate and reload Caddy

**Files:** none in git.

- [ ] **Step 1: Check drift**

```bash
cd ~/repos/sandbox/apps/cli && ./sandbox setup --check
```

Expected: the "ingress certificate" step fails, naming the two new hostnames as uncovered.

- [ ] **Step 2: Regenerate**

```bash
cd ~/repos/sandbox/apps/cli && ./sandbox setup --yes && ./sandbox proxy-reload
```

Expected: certificate step ✓ covering 4 hostnames; proxy reload succeeds.

- [ ] **Step 3: Verify**

```bash
openssl x509 -in ~/.docker/certs/localhost.crt -noout -ext subjectAltName | tr ',' '\n' | grep -E 'dashboard|claudeck'
curl -sk -o /dev/null -w '%{http_code}\n' https://dashboard.local.sandbox.com/
```

Expected: both hostnames in the SANs; the curl returns a non-connection-refused status (502 or a selector page is fine, nothing is running yet). `./sandbox setup --check` now reports no drift.

---

### Task 5: Prove it with a workspace

**Files:** none in git (creates `~/features/selfhost`).

- [ ] **Step 1: Create the workspace**

```bash
cd ~/repos/sandbox/apps/cli && ./sandbox workspace selfhost \
  --repos sandbox \
  --services sandbox-core,cli,vscode-plugin,sandbox-dashboard,claudeck \
  --task "Self-host the sandbox repo" --work-type spike \
  --starting-prompt "Smoke workspace for running the sandbox repo's own services in containers. Nothing to build."
```

Expected: a worktree at `~/features/selfhost/sandbox` on branch `jayboyer/selfhost`, and `.sandbox/workspace.yml` listing the five services.

- [ ] **Step 2: Bring it up**

```bash
cd ~/features/selfhost && sandbox up selfhost
```

Expected: `selfhost-sandbox-install` exits 0 (install, build, three tool version lines in its log), then five app containers healthy. First run takes several minutes for `npm install` and `npm run build`.

- [ ] **Step 3: Verify containers and the in-container CLI**

```bash
docker ps --filter label=com.sandbox.local.feature=selfhost --format '{{.Names}}\t{{.Status}}'
docker logs selfhost-sandbox-install 2>&1 | tail -5
docker exec selfhost-cli which sandbox docker kubectl
docker exec selfhost-cli sandbox status
docker exec selfhost-cli docker ps --format '{{.Names}}' | grep selfhost- | wc -l
docker exec selfhost-cli kubectl --context orbstack get nodes
```

Expected: five `(healthy)` containers; `which sandbox` prints `/app/apps/cli/sandbox`; `sandbox status` inside lists `selfhost` the same as on the host; docker ps from inside counts 5 or more. If `kubectl get nodes` cannot reach the cluster, record that in Task 6 as the limitation the spec anticipated. Do not try to fix it here.

- [ ] **Step 4: Verify both UIs through Caddy**

Find the cookie name in `apps/cli/infra/templates/Caddyfile.njk` (it is the `X-Feature` cookie), then:

```bash
curl -sk -b 'X-Feature=selfhost' -o /dev/null -w '%{http_code}\n' https://dashboard.local.sandbox.com/
curl -sk -b 'X-Feature=selfhost' https://dashboard.local.sandbox.com/ | head -c 300
curl -sk -b 'X-Feature=selfhost' -o /dev/null -w '%{http_code}\n' https://claudeck.local.sandbox.com/
```

Expected: 200 and HTML from both. A 502 on the dashboard means Task 1's `HOST` did not take effect; check `docker exec selfhost-sandbox-dashboard env | grep HOST`.

- [ ] **Step 5: Verify the watcher rebuilds**

```bash
echo '// rebuild-probe' >> ~/features/selfhost/sandbox/packages/sandbox-core/colors.ts
sleep 5; docker logs --since 30s selfhost-sandbox-core 2>&1 | tail -3
git -C ~/features/selfhost/sandbox checkout packages/sandbox-core/colors.ts
```

Expected: a fresh `Found 0 errors. Watching for file changes.` line after the edit.

- [ ] **Step 6: Leave it running and report**

Do not tear the workspace down; the user decides. Report the exact output of Steps 3 to 5, including any failure, in the final message.

---

### Task 6: Document the self-hosting setup and its hazards

**Files:**
- Modify: `docs/users-guide.md` (after the "Setup Services" subsection, before `## Port Allocation`)
- Modify: `README.md` (one sentence in the Workspaces intro)
- Create: `.changeset/self-host-services.md`

- [ ] **Step 1: Add the users-guide section**

Insert before `## Port Allocation`:

```markdown
### Self-hosting the sandbox repo

The five workspaces of this repo (`apps/cli`, `apps/claudeck`, `apps/sandbox-dashboard`,
`packages/sandbox-core`, `packages/vscode-plugin`) can be registered as services so a
feature workspace develops the sandbox itself, each package in its own container. The
registry shape lives in `docs/superpowers/archive/specs/2026-09-03-self-host-services-design.md`;
the pieces that are not obvious from the demo services:

- **One `node:22` image everywhere.** `better-sqlite3`, `keytar`, `sharp` and the
  esbuild/rollup/swc binaries ship glibc prebuilds only; alpine will not load them.
- **Watch loops need no listener.** The compose template always publishes a port and its
  healthcheck is `curl … || exit 0`, so `tsc --watch` containers read healthy with a
  placeholder `internal_port`.
- **Host access for `cli`, `sandbox-dashboard` and `claudeck`.** Those three drive the host:
  they get `/var/run/docker.sock` plus `~/.sandbox`, `~/repos`, `~/features` and `~/.kube`
  bind-mounted at their *host* paths, `HOME` set to match, and the docker, compose and
  kubectl binaries from the per-feature `tools` volume that
  `infra/compose/scripts/sandbox-install-startup.sh` fills. The generated compose files carry
  host bind-mount paths and the daemon is the host's, so the paths must be identical on both
  sides.
- **`sandbox` inside the container is the worktree's own build.** `PATH` puts
  `/app/apps/cli` first. `sandbox_root` in `~/.sandbox/config.yaml` still points at the main
  checkout, so templates and `infra/` come from there (see the known issue on machine-global
  `sandbox_root`). **Never run `sandbox config` or `sandbox setup` from a worktree**, on the
  host or in the container: it silently repoints the whole machine.
- **The dashboard binds `HOST`.** It defaults to loopback for the reasons in `main.ts`; the
  registry sets `HOST=0.0.0.0` because the container network is the isolation boundary and
  Docker's published port is the only way in.
- **Not covered:** Telepresence intercepts (need a root daemon on the host), and the `gh` and
  `claude` binaries. Run `sandbox intercept` from the host.
```

If Task 5 Step 3 found the cluster unreachable from inside the container, append to the "Not covered" bullet: `kubectl` inside the container has the binary and kubeconfig but cannot reach OrbStack's API server; run `sandbox connect` from the host.

- [ ] **Step 2: Add the README pointer**

After the sentence "`sandbox-core` is the one shared dependency …" paragraph in `README.md`, add:

```markdown
Every workspace here can also be run as a sandbox service of its own, so a feature
workspace can develop the sandbox inside the sandbox — see "Self-hosting the sandbox repo"
in [docs/users-guide.md](docs/users-guide.md).
```

- [ ] **Step 3: Add the changeset**

```bash
cat > .changeset/self-host-services.md <<'CS'
---
"@jbbz-sandbox/sandbox-cli": patch
---

Ship `infra/compose/scripts/sandbox-install-startup.sh` (docker/compose/kubectl into a feature tools volume) and let the dashboard bind `HOST`, so the sandbox repo's own apps and packages can run as sandbox services.
CS
```

- [ ] **Step 4: Commit**

```bash
git add docs/users-guide.md README.md .changeset/self-host-services.md docs/superpowers/archive/plans/2026-09-03-self-host-services.md
git commit -m "docs: self-hosting the sandbox repo as sandbox services"
```
