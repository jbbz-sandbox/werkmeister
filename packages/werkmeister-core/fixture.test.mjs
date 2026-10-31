// SW-184: WERKMEISTER_FIXTURE=1 keeps a test off the host's shared plumbing.
// SW-164: a fixture `up` reloaded the real w9r-caddy through dockerode, which no
// PATH shim catches. SW-177: a test that forgot withFakeGh ran the real gh.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as http from "node:http";
import { after, before, test } from "node:test";
import { useDockerEngine } from "./fixtures.mjs";

useDockerEngine();

// Any Docker call fails the test: the fixture switch must return before one.
let dockerHits = 0;
const engine = http.createServer((_req, res) => {
  dockerHits++;
  res.writeHead(500).end();
});

let caddy;
let claudeCli;
// The "test" script's default gh stub would beat the fixture stub these tests probe.
const suiteGhBin = process.env.WERKMEISTER_GH_BIN;
before(async () => {
  delete process.env.WERKMEISTER_GH_BIN;
  await new Promise((resolve) => engine.listen(0, "127.0.0.1", resolve));
  process.env.DOCKER_HOST = `tcp://127.0.0.1:${engine.address().port}`;
  process.env.WERKMEISTER_FIXTURE = "1";
  caddy = await import("./dist/caddy.js");
  claudeCli = await import("./dist/claude_cli.js");
});
after(() => {
  if (suiteGhBin !== undefined) process.env.WERKMEISTER_GH_BIN = suiteGhBin;
  delete process.env.WERKMEISTER_FIXTURE;
  engine.close();
});

test("Caddy reload and start are skipped without touching Docker", async () => {
  assert.equal(await caddy.reloadCaddy(), true);
  assert.equal(caddy.startCaddy(), true);
  assert.equal(dockerHits, 0);
});

test("gh is a stub that fails loudly unless WERKMEISTER_GH_BIN names a fake", () => {
  const stub = claudeCli.ghBin();
  assert.notEqual(stub, "gh");
  assert.throws(
    () => execFileSync(stub, ["pr", "list"], { stdio: "pipe" }),
    (e) => e.status === 1 && /gh called under WERKMEISTER_FIXTURE: pr list/.test(e.stderr),
  );
  process.env.WERKMEISTER_GH_BIN = "/fake/gh";
  try {
    assert.equal(claudeCli.ghBin(), "/fake/gh");
  } finally {
    delete process.env.WERKMEISTER_GH_BIN;
  }
});

test("without the switch, gh is the real one", () => {
  delete process.env.WERKMEISTER_FIXTURE;
  try {
    assert.equal(claudeCli.ghBin(), "gh");
  } finally {
    process.env.WERKMEISTER_FIXTURE = "1";
  }
});
