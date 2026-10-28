// SW-137: a server whose checkout was deleted still holds its port and its PID,
// but every request dies in body parsing with HTTP 400. start() must not
// trust a live PID alone -- it has to replace a server that cannot serve, and
// still leave a working one alone.
//
// Hermetic: tmp HOME for the PID file, and an ephemeral port in place of
// MCP.port so the host's real server on 3002 is never touched.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { dotDir } from "./dist/dot_dir.js";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { MCP, start } from "./dist/web_servers.js";

/** Run start() against a stub that answers every request with *code*. */
async function startOverStub(code) {
  const stub = spawn(
    process.execPath,
    [
      "-e",
      `require('http').createServer((q,s)=>{s.statusCode=${code};s.end()})` +
        ".listen(0,'127.0.0.1',function(){console.log(this.address().port)})",
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const [chunk] = await once(stub.stdout, "data");
  const app = { ...MCP, port: Number(String(chunk).trim()) };

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "web-servers-stale-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  const pidFile = path.join(dotDir(home), `${MCP.stem}.pid`);
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, String(stub.pid));
  try {
    const reporter = collectingReporter();
    await withReporter(reporter, () => start(app, false));
    return { stopped: (stub.exitCode ?? stub.signalCode) !== null, text: reporter.text() };
  } finally {
    stub.kill("SIGKILL");
    // Whatever start() put in its place.
    try {
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      if (pid !== stub.pid) process.kill(pid, "SIGKILL");
    } catch {}
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("start() replaces a live server that answers 400 to every request", async () => {
  const { stopped, text } = await startOverStub(400);
  assert.ok(stopped, text);
  assert.match(text, /not serving/);
});

test("start() leaves a live server that answers 401 alone", async () => {
  const { stopped, text } = await startOverStub(401);
  assert.ok(!stopped, text);
  assert.match(text, /already running/);
});
