// werkmeister-context.md is loaded on demand, but when it loads it should describe
// this workspace — not every host on the machine and a hardcoded infra table
// whose ports had already drifted from the registry.

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadServices } from "../dist/config.js";
import { buildSandboxContextMd } from "../dist/harness/claude/claude_md.js";
import { withSandboxHome } from "./fixtures.mjs";

const SERVICES = `services:
  frontend:
    type: web
    repo: demo-repo
    path: apps/frontend
    port_offset: 1
    test: npm test -w frontend
    feature_router: {}
  backend:
    type: api
    repo: demo-repo
    path: apps/backend
    port_offset: 2
    k8s_forward_port: 9052
    feature_router: {}
  dashboard:
    type: web
    repo: other
    port_offset: 3
    k8s_forward_port: 9060
    feature_router: {}
`;

test("health checks and the feature URL are scoped to the local services", async () => {
  await withSandboxHome(
    async () => {
      const out = buildSandboxContextMd("test", 1, 11100, 11119, ["frontend"], loadServices(), "/");
      const curls = out.match(/curl -sk -b "X-Feature=test"[^\n]*/g) ?? [];
      assert.equal(curls.length, 1, curls.join("\n"));
      assert.match(curls[0], /frontend\.local\.werkmeister\.io/);
      assert.match(out, /\*\*Feature URL:\*\* https:\/\/frontend\.local\.werkmeister\.io\//);
      assert.match(
        out,
        /document\.cookie = "X-Feature=test; domain=\.local\.werkmeister\.io; path=\/; SameSite=Lax"/,
      );
      assert.match(out, /frontend\.local\.werkmeister\.io\/__werkmeister/);
      assert.match(
        out,
        /\| `frontend` \| local \| `apps\/frontend` \| `test-frontend` \| 11101 \|/,
      );
      assert.match(out, /\| `backend` \| k8s \| `apps\/backend` \| — \| — \|/);
      assert.match(out, /\| `dashboard` \| k8s \| `\.` \|/, "a service without path: renders '.'");
      assert.doesNotMatch(out, /## Infrastructure/);
      assert.match(
        out,
        /- `https:\/\/dashboard\.local\.werkmeister\.io`/,
        "the routed-host list stays machine-wide",
      );
    },
    { services: SERVICES },
  );
});

// SW-746: JIT sessions read this section to exercise, so the host-script rule reaches them here.
test("How to validate says a host-only check is a logged script run with one ! sh line", async () => {
  await withSandboxHome(
    async () => {
      const out = buildSandboxContextMd("test", 1, 11100, 11119, ["frontend"], loadServices());
      const validate = out.slice(out.indexOf("## How to validate"));
      assert.match(
        validate,
        /^How to exercise .*one `! sh <absolute path>` line with the script.s commands shown beside it, then read the log/m,
      );
    },
    { services: SERVICES },
  );
});

// SW-765: a spec planned to delete turbo cache entries, not knowing every workspace shares the volume.
test("Test commands names each registry cache as a shared volume never to delete from", async () => {
  await withSandboxHome(
    async () => {
      const caches = { turbo: { path: "/turbo-cache", env: { TURBO_CACHE_DIR: "/turbo-cache" } } };
      const args = [
        "test",
        1,
        11100,
        11119,
        ["frontend"],
        loadServices(),
        "",
        null,
        ["frontend"],
        false,
        "",
        {},
      ];
      const out = buildSandboxContextMd(...args, caches);
      assert.match(
        out,
        /^Shared caches, mounted by every workspace on this machine: never delete from them .*`turbo` at `\/turbo-cache` \(`TURBO_CACHE_DIR=\/turbo-cache`, volume `werkmeister-turbo`\)\.$/m,
      );
      assert.doesNotMatch(buildSandboxContextMd(...args, {}), /Shared caches/);
    },
    { services: SERVICES },
  );
});

test("no test path means the feature URL is the host root", async () => {
  await withSandboxHome(
    async () => {
      const out = buildSandboxContextMd("test", 1, 11100, 11119, ["frontend"], loadServices());
      assert.match(out, /\*\*Feature URL:\*\* https:\/\/frontend\.local\.werkmeister\.io\/\n/);
    },
    { services: SERVICES },
  );
});

test("each local service's test command runs in its container; none says so", async () => {
  await withSandboxHome(
    async () => {
      const out = buildSandboxContextMd(
        "test",
        1,
        11100,
        11119,
        ["frontend", "backend"],
        loadServices(),
        "",
        {},
      );
      assert.match(
        out,
        /^- `frontend`: `docker exec test-frontend sh -c 'npm test -w frontend'`$/m,
      );
      assert.match(
        out,
        /^- `backend`: no test command registered \(add `test:` to its registry entry\)$/m,
      );
    },
    { services: SERVICES },
  );
});

test("a host-access container that sees the workspace prints its test under with-temp-home; others stay bare (SW-769)", async () => {
  await withSandboxHome(
    async () => {
      const out = buildSandboxContextMd(
        "test",
        1,
        11100,
        11119,
        ["core", "sock", "frontend"],
        loadServices(),
        "",
        {},
        ["core", "sock", "frontend"],
        false,
        "/ws/.werkmeister/bin/with-temp-home",
      );
      assert.match(
        out,
        /^- `core`: `docker exec -w \/app test-core \/ws\/\.werkmeister\/bin\/with-temp-home --no-wait sh -c 'npm test'`$/m,
      );
      assert.match(
        out,
        /^- `frontend`: `docker exec test-frontend sh -c 'npm test -w frontend'`$/m,
      );
      // docker.sock alone: <ws>/.werkmeister/bin is not in that container, so the wrapped form would exit 127.
      assert.match(out, /^- `sock`: `docker exec test-sock sh -c 'npm test'`$/m);
    },
    {
      services: `${SERVICES}  core:
    type: library
    repo: demo-repo
    path: packages/core
    test: npm test
    extra_volumes: ["/var/run/docker.sock:/var/run/docker.sock", "/ws:/ws"]
  sock:
    type: library
    repo: demo-repo
    path: packages/sock
    test: npm test
    extra_volumes: ["/var/run/docker.sock:/var/run/docker.sock"]
`,
    },
  );
});

test("a service whose registry says test: none shows its reason, not a missing command (SW-119)", async () => {
  await withSandboxHome(
    async () => {
      const out = buildSandboxContextMd(
        "test",
        1,
        11100,
        11119,
        ["backend"],
        loadServices(),
        "",
        {},
      );
      assert.match(out, /^- `backend`: no tests \(registry: no test script\)$/m);
    },
    {
      services: SERVICES.replace(
        "    k8s_forward_port: 9052\n",
        '    k8s_forward_port: 9052\n    test: "none: no test script"\n',
      ),
    },
  );
});

test("the host test command is stated through the temp-HOME wrapper; the container form is not (SW-124)", async () => {
  await withSandboxHome(
    async () => {
      const args = [
        "test",
        1,
        11100,
        11119,
        ["frontend"],
        loadServices(),
        "",
        {},
        ["frontend"],
        false,
      ];
      const wrapped = buildSandboxContextMd(...args, "/ws/.werkmeister/bin/with-temp-home");
      assert.match(
        wrapped,
        /\| `\/ws\/\.werkmeister\/bin\/with-temp-home --cwd \/ws\/demo-repo npm test -w frontend` \|/,
      );
      assert.match(
        wrapped,
        /^- `frontend`: `docker exec test-frontend sh -c 'npm test -w frontend'`$/m,
      );
      assert.match(
        wrapped,
        /`\/ws\/\.werkmeister\/bin\/with-temp-home env WERKMEISTER_ROOT=… <cmd>`/,
      );
      assert.match(
        wrapped,
        /`Bash\(\/ws\/\.werkmeister\/bin\/with-temp-home --cwd <worktree> <test command>:\*\)`/,
      );
      assert.doesNotMatch(buildSandboxContextMd(...args), /with-temp-home/);
    },
    { services: SERVICES },
  );
});

test("Container Lifecycle mentions auto-stop only when it is on (#231)", async () => {
  await withSandboxHome(
    async () => {
      const args = ["test", 1, 11100, 11119, ["frontend"], loadServices()];
      const on = buildSandboxContextMd(...args, "", null, ["frontend"], true);
      assert.match(
        on,
        /## Container Lifecycle[\s\S]*Auto-stop is on[\s\S]*werkmeister internal session-end/,
      );
      assert.doesNotMatch(buildSandboxContextMd(...args), /--if-idle/);
    },
    { services: SERVICES },
  );
});

test("a baseline service's row shows its upstream URL (SW-102)", async () => {
  await withSandboxHome(
    async () => {
      const out = buildSandboxContextMd("test", 1, 11100, 11119, ["frontend"], loadServices());
      assert.match(
        out,
        /\| `backend` \| baseline \| `apps\/backend` \| — \| — \| `BACKEND_URL=http:\/\/baseline-backend:3000` \|/,
      );
    },
    {
      services: SERVICES.replace(
        "    k8s_forward_port: 9052\n",
        '    k8s_forward_port: 9052\n    baseline_upstream: "baseline-backend:3000"\n',
      ),
    },
  );
});

test("local-only hosts are marked and the features.json line is added (SW-300)", async () => {
  await withSandboxHome(
    async () => {
      const out = buildSandboxContextMd("test", 1, 11100, 11119, ["frontend"], loadServices(), "/");
      // Every SERVICES host is `feature_router: {}`: local-only, in both sections.
      assert.match(
        out,
        /# frontend\.local\.werkmeister\.io answers only while a feature runs its service/,
      );
      assert.match(
        out,
        /- `https:\/\/dashboard\.local\.werkmeister\.io` — answers only while a feature runs its service/,
      );
      assert.match(
        out,
        /curl exit 35\) while `w9r-caddy` is healthy, check `~\/\.werkmeister\/infra\/proxy\/features\.json` first/,
      );
    },
    { services: SERVICES },
  );
});

test("a host with a remote upstream is not marked local-only (SW-300)", async () => {
  await withSandboxHome(
    async () => {
      const out = buildSandboxContextMd("test", 1, 11100, 11119, ["frontend"], loadServices(), "/");
      assert.doesNotMatch(out, /frontend\.local\.werkmeister\.io`? (— )?answers only/);
      assert.match(out, /dashboard\.local\.werkmeister\.io` — answers only/);
    },
    // Only frontend gets a remote upstream; backend and dashboard stay local-only.
    {
      services: SERVICES.replace(
        "feature_router: {}",
        "feature_router: {remote_upstream: k8s-fe:9051}",
      ),
    },
  );
});

test("SW-872: a host-access mount from dev_links alone still prints the test under with-temp-home", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { withComposeMounts } = await import("../dist/archetypes.js");
  const { workspaceServices } = await import("../dist/registry_sync.js");
  await withSandboxHome(
    async (home) => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-devlinks-"));
      fs.mkdirSync(path.join(ws, ".werkmeister"));
      fs.writeFileSync(
        path.join(ws, ".werkmeister", "workspace.yml"),
        `dev_links:\n  core: ["${home}:${home}", "\${WORKSPACE}:\${WORKSPACE}"]\n`,
      );
      const tempHome = path.join(ws, ".werkmeister", "bin", "with-temp-home");
      const ctx = (cfg) =>
        buildSandboxContextMd(
          "test",
          1,
          11100,
          11119,
          ["core"],
          cfg,
          "",
          {},
          ["core"],
          false,
          tempHome,
        );
      const line = (out) => out.split("\n").find((l) => l.startsWith("- `core`: "));
      assert.ok(
        !line(ctx(loadServices())).includes(tempHome),
        "registry alone: no host access seen",
      );
      assert.ok(
        line(
          ctx(withComposeMounts(loadServices(), ws, workspaceServices(loadServices(), ws))),
        ).includes(`${tempHome} --no-wait`),
      );
    },
    {
      services: `${SERVICES}  core:
    type: library
    repo: demo-repo
    path: packages/core
    test: npm test
`,
    },
  );
});
