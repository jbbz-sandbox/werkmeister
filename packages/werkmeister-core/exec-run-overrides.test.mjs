// SW-208: pr_lifecycle's default `run` and proc.run/runAsync resolve gh and docker through
// WERKMEISTER_GH_BIN / WERKMEISTER_DOCKER_BIN. childEnv() puts /opt/homebrew/bin
// and /usr/local/bin ahead of PATH, so a fake on PATH alone loses to the real CLI.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { defaultDeps } from "./dist/pr_lifecycle.js";
import { run, runAsync } from "./dist/proc.js";
import { pinWerkmeisterRoot, withSandboxHome } from "./fixtures.mjs";

pinWerkmeisterRoot();

function fake(name) {
  const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `fake-${name}-`)), name);
  fs.writeFileSync(bin, `#!/bin/sh\necho "fake ${name}: $*"\n`, { mode: 0o755 });
  return bin;
}

for (const [name, env] of [
  ["gh", "WERKMEISTER_GH_BIN"],
  ["docker", "WERKMEISTER_DOCKER_BIN"],
]) {
  test(`execRun runs ${name} from ${env}`, async () => {
    const prev = process.env[env];
    process.env[env] = fake(name);
    try {
      const res = await withSandboxHome(() => defaultDeps().run(name, ["ps"], os.tmpdir()));
      assert.equal(res.stdout.trim(), `fake ${name}: ps`);
      assert.equal(res.code, 0);
    } finally {
      if (prev === undefined) delete process.env[env];
      else process.env[env] = prev;
    }
  });
}

test("proc.run and runAsync run docker from WERKMEISTER_DOCKER_BIN", async () => {
  const prev = process.env.WERKMEISTER_DOCKER_BIN;
  process.env.WERKMEISTER_DOCKER_BIN = fake("docker");
  try {
    assert.equal(
      run(["docker", "compose", "ps"], { capture: true }).stdout.trim(),
      "fake docker: compose ps",
    );
    const res = await runAsync(["docker", "ps"], { capture: true });
    assert.equal(res.stdout.trim(), "fake docker: ps");
  } finally {
    if (prev === undefined) delete process.env.WERKMEISTER_DOCKER_BIN;
    else process.env.WERKMEISTER_DOCKER_BIN = prev;
  }
});
