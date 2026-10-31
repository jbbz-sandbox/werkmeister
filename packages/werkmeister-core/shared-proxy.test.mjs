// SW-279: a fixture teardown (temp HOME, WERKMEISTER_CONFIG_FILE, no
// WERKMEISTER_FIXTURE) reloaded the real w9r-caddy with the fixture's Caddyfile,
// taking routing down for every workspace. reloadCaddy is where every caller
// (teardown, `feature down`, `infra proxy-reload`, MCP) reaches Docker.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { useDockerEngine, withSandboxHome } from "./fixtures.mjs";

useDockerEngine();

// Any Docker call fails the test: a fixture home must not reach the shared proxy.
let dockerHits = 0;
const engine = http.createServer((_req, res) => {
  dockerHits++;
  res.writeHead(500).end();
});

let caddy;
before(async () => {
  delete process.env.WERKMEISTER_FIXTURE;
  delete process.env.WERKMEISTER_CONFIG_FILE;
  await new Promise((resolve) => engine.listen(0, "127.0.0.1", resolve));
  process.env.DOCKER_HOST = `tcp://127.0.0.1:${engine.address().port}`;
  caddy = await import("./dist/caddy.js");
});
after(() => engine.close());

// What reloadProxy's generate step leaves in a home before the reload.
function seedCaddyfile(home) {
  fs.mkdirSync(path.join(home, "infra", "proxy"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "infra", "proxy", "Caddyfile"),
    "frontend.local.werkmeister.io {}\n",
  );
}

test("a non-default config home does not reload the shared Caddy", async () => {
  dockerHits = 0;
  await withSandboxHome(async (home) => {
    seedCaddyfile(home);
    assert.equal(await caddy.reloadCaddy(), true);
  });
  assert.equal(dockerHits, 0);
});

test("the default config home still reloads it", async () => {
  dockerHits = 0;
  // A temp HOME is the default home here; the fake engine stands in for w9r-caddy.
  const prevHome = process.env.HOME;
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "werkmeister-default-home-"));
  try {
    seedCaddyfile(path.join(os.homedir(), ".werkmeister"));
    assert.equal(await caddy.reloadCaddy(), false);
  } finally {
    fs.rmSync(process.env.HOME, { recursive: true, force: true });
    process.env.HOME = prevHome;
  }
  assert.ok(dockerHits > 0);
});
