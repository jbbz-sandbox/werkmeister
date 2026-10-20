// SW-59: compose status reads go through `projectContainers` instead of
// `docker compose ps`. A fake Engine on a unix socket pins the label filters it
// sends and the compose-shaped records it builds, with no real daemon.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const CADDY_PORTS = [
  { IP: "0.0.0.0", PrivatePort: 80, PublicPort: 80, Type: "tcp" },
  { IP: "::", PrivatePort: 80, PublicPort: 80, Type: "tcp" },
  { IP: "0.0.0.0", PrivatePort: 443, PublicPort: 443, Type: "tcp" },
  { IP: "::", PrivatePort: 443, PublicPort: 443, Type: "tcp" },
  { PrivatePort: 443, Type: "udp" },
  { PrivatePort: 2019, Type: "tcp" },
];

const FIXTURE = [
  {
    Id: "2b738b1da7be0000",
    Names: ["/sandbox-caddy"],
    State: "running",
    Status: "Up 34 hours (healthy)",
    Ports: CADDY_PORTS,
    Labels: {
      "com.docker.compose.project": "sandbox-infra",
      "com.docker.compose.service": "caddy",
    },
  },
  {
    Id: "aaaaaaaaaaaa0000",
    Names: ["/demo-install"],
    State: "exited",
    Status: "Exited (0) 2 hours ago",
    Ports: [],
    Labels: { "com.docker.compose.service": "install", "com.sandbox.local.role": "setup" },
  },
  {
    Id: "bbbbbbbbbbbb0000",
    Names: ["/demo-backend"],
    State: "exited",
    Status: "Exited (137) 5 minutes ago",
    Ports: [],
    Labels: { "com.docker.compose.service": "backend" },
  },
  {
    Id: "cccccccccccc0000",
    Names: ["/demo-frontend"],
    State: "running",
    Status: "Up 5 seconds (health: starting)",
    Ports: [
      { IP: "::", PrivatePort: 3998, PublicPort: 11203, Type: "tcp" },
      { IP: "0.0.0.0", PrivatePort: 3998, PublicPort: 11203, Type: "tcp" },
    ],
    Labels: { "com.docker.compose.service": "frontend" },
  },
];

const dir = mkdtempSync(path.join(tmpdir(), "sandbox-fake-engine-"));
const sock = path.join(dir, "docker.sock");
const queries = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://engine");
  queries.push({
    path: url.pathname,
    all: url.searchParams.get("all"),
    filters: JSON.parse(url.searchParams.get("filters") ?? "{}"),
  });
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(FIXTURE));
});
await new Promise((resolve) => server.listen(sock, resolve));
process.env.DOCKER_HOST = `unix://${sock}`;

const { displayPorts, projectContainers } = await import("./dist/docker.js");

after(() => rmSync(dir, { recursive: true, force: true }));

test("projectContainers filters by project, non-oneoff and service, all by default", async () => {
  queries.length = 0;
  await projectContainers("sandbox-infra", "caddy");
  await projectContainers("sandbox-demo", undefined, { all: false });
  await projectContainers();
  assert.ok(queries.every((q) => q.path.endsWith("/containers/json")));
  assert.deepEqual(
    queries.map((q) => [q.all, q.filters.label]),
    [
      [
        "true",
        [
          "com.docker.compose.project=sandbox-infra",
          "com.docker.compose.oneoff=False",
          "com.docker.compose.service=caddy",
        ],
      ],
      ["false", ["com.docker.compose.project=sandbox-demo", "com.docker.compose.oneoff=False"]],
      // No project: every compose container, by label key alone.
      ["true", ["com.docker.compose.project", "com.docker.compose.oneoff=False"]],
    ],
  );
});

test("projectContainers returns compose ps's fields", async () => {
  const rows = await projectContainers("sandbox-demo");
  // Sorted by name, as compose lists them; the Engine returns newest first.
  assert.deepEqual(
    rows.map(({ labels, ...r }) => r),
    [
      {
        name: "demo-backend",
        state: "exited",
        health: "",
        ports: "",
        service: "backend",
        exitCode: 137,
      },
      {
        name: "demo-frontend",
        state: "running",
        health: "starting",
        ports: "0.0.0.0:11203->3998/tcp, [::]:11203->3998/tcp",
        service: "frontend",
        exitCode: 0,
      },
      {
        name: "demo-install",
        state: "exited",
        health: "",
        ports: "",
        service: "install",
        exitCode: 0,
      },
      {
        name: "sandbox-caddy",
        state: "running",
        health: "healthy",
        ports:
          "0.0.0.0:80->80/tcp, [::]:80->80/tcp, 0.0.0.0:443->443/tcp, [::]:443->443/tcp, 443/udp, 2019/tcp",
        service: "caddy",
        exitCode: 0,
      },
    ],
  );
  assert.equal(rows[2].labels["com.sandbox.local.role"], "setup");
});

test("displayPorts groups consecutive same-port mappings as docker ps does", () => {
  assert.equal(
    displayPorts([
      { PrivatePort: 8081, Type: "tcp" },
      { PrivatePort: 8080, Type: "tcp" },
      { PrivatePort: 9000, Type: "tcp" },
      { IP: "0.0.0.0", PrivatePort: 81, PublicPort: 81, Type: "tcp" },
      { IP: "0.0.0.0", PrivatePort: 80, PublicPort: 80, Type: "tcp" },
    ]),
    // Go's order: a group closed mid-loop lands before the ones still open.
    "8080-8081/tcp, 0.0.0.0:80-81->80-81/tcp, 9000/tcp",
  );
  assert.equal(displayPorts([]), "");
});

// Last: it closes the fake daemon.
test("projectContainers returns null when the daemon can't be reached", async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await projectContainers("sandbox-demo"), null);
});
