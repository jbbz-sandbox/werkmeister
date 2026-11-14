// SW-679: scripts/host-daemon.mjs runs the branch's bundled daemon on a temp HOME and a free port, hands a command
// its address and token, and leaves nothing behind. Runs where apps/cli has its node_modules (the container).

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "apps/werkmeister-mcp/scripts/host-daemon.mjs");
const MODULES = path.join(ROOT, "apps/cli/node_modules");
const built = fs.existsSync(path.join(ROOT, "apps/cli/dist/mcp.js"));
const installed = fs.existsSync(path.join(MODULES, "dockerode"));
const skip = !built ? "apps/cli not built" : !installed ? "apps/cli has no node_modules" : false;

// What the command sees, and /api/status without and with the token.
const PROBE = `
const h = process.env.WERKMEISTER_HOST;
const get = (auth) => fetch(h + "/api/status", auth ? { headers: { authorization: "Bearer " + process.env.WERKMEISTER_MCP_TOKEN } } : {}).then((r) => r.status);
// A container reaches it as host.docker.internal; fetch can't set Host, node:http can.
const { request } = await import("node:http");
const docker = await new Promise((ok, ko) => request(h + "/api/status", { headers: { host: "host.docker.internal:" + process.env.WERKMEISTER_MCP_PORT } }, (r) => { r.resume(); ok(r.statusCode); }).on("error", ko).end());
console.log(JSON.stringify({ home: process.env.HOME, port: Number(process.env.WERKMEISTER_MCP_PORT), host: h, anon: await get(false), authed: await get(true), docker, workspaces: process.env.WERKMEISTER_WORKSPACES_ROOT ?? null, fixture: process.env.WERKMEISTER_FIXTURE }));
`;

test("runs a command against the branch daemon on a temp HOME and a free port", {
  skip,
}, async () => {
  const { stdout } = await run(
    process.execPath,
    [SCRIPT, "--", process.execPath, "--input-type=module", "-e", PROBE],
    {
      cwd: ROOT,
      // The host shell exports env.sh's paths; none may reach the temp daemon or the command.
      env: {
        ...process.env,
        WERKMEISTER_MODULES: MODULES,
        WERKMEISTER_WORKSPACES_ROOT: "/real/features",
      },
      timeout: 60_000,
    },
  );
  const seen = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.equal(seen.workspaces, null, "the caller's WERKMEISTER_* is dropped");
  assert.equal(seen.fixture, "1");
  assert.notEqual(seen.port, 3002);
  assert.equal(seen.host, `http://127.0.0.1:${seen.port}`);
  assert.ok(seen.home.startsWith(fs.realpathSync(os.tmpdir())), seen.home);
  assert.equal(seen.anon, 401);
  assert.equal(seen.authed, 200);
  assert.equal(
    seen.docker,
    401,
    "a container's Host header reaches the token check, not the SDK's localhost 403",
  );
  assert.equal(fs.existsSync(seen.home), false, "temp HOME removed on exit");
});

test("passes the command's exit code through", { skip }, async () => {
  const err = await run(process.execPath, [SCRIPT, "--", "sh", "-c", "exit 7"], {
    cwd: ROOT,
    env: { ...process.env, WERKMEISTER_MODULES: MODULES },
    timeout: 60_000,
  }).catch((e) => e);
  assert.equal(err.code, 7);
});

// launchctl acts on the real login session whatever HOME is, so `daemon install` here would replace the host daemon.
test("the command's launchctl and crontab are stubs that fail", { skip }, async () => {
  const err = await run(
    process.execPath,
    [SCRIPT, "--", "sh", "-c", 'command -v launchctl; launchctl list; echo "rc $?"'],
    { cwd: "/", env: { ...process.env, WERKMEISTER_MODULES: MODULES }, timeout: 60_000 },
  );
  const [where, rc] = err.stdout.trim().split("\n");
  assert.ok(where.startsWith(fs.realpathSync(os.tmpdir())), where);
  assert.equal(rc, "rc 1");
  assert.match(err.stderr, /launchctl is blocked/);
});

test("names a dependency the modules folder lacks", {
  skip: !built && "apps/cli not built",
}, async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "host-daemon-mods-"));
  try {
    const err = await run(process.execPath, [SCRIPT, "--", "true"], {
      cwd: ROOT,
      env: { ...process.env, WERKMEISTER_MODULES: empty },
    }).catch((e) => e);
    assert.equal(err.code, 2);
    assert.match(err.stderr, /lacks .*dockerode/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
