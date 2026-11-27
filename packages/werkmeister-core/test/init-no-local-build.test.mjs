// SW-929: init skips the image build, with an info line, when no service runs outside the on-demand
// profile; a workspace with a local service still builds. Docker is a logging fake (WERKMEISTER_DOCKER_BIN).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { collectingReporter, withReporter } from "../dist/reporter.js";
import { initWorkspace } from "../dist/workspace_init.js";
import { pinWerkmeisterRoot, withSandboxHome } from "./fixtures.mjs";

pinWerkmeisterRoot();

const REGISTRY =
  "services:\n  backend:\n    repo: demo-repo\n    type: api\n    port_offset: 2\n    command: node server.js\n";

async function init(services) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "init-no-build-"));
  const ws = path.join(tmp, "features", "demo-ws");
  fs.mkdirSync(path.join(ws, "demo-repo", ".git"), { recursive: true });
  fs.mkdirSync(path.join(ws, ".werkmeister"));
  fs.writeFileSync(
    path.join(ws, ".werkmeister", "workspace.yml"),
    `task: t\nwork_type: bug\nfeature: demo\nservices: "${services}"\ncontext_strategy: icm\n`,
  );
  const log = path.join(tmp, "docker.log");
  const bin = path.join(tmp, "docker");
  fs.writeFileSync(bin, `#!/bin/sh\necho "$@" >> '${log}'\n`, { mode: 0o755 });
  const prev = process.env.WERKMEISTER_DOCKER_BIN;
  process.env.WERKMEISTER_DOCKER_BIN = bin;
  try {
    const reporter = collectingReporter();
    await withSandboxHome(() => withReporter(reporter, () => initWorkspace({}, ws, {})), {
      services: REGISTRY,
      config: `paths:\n  repos_root: ${path.join(tmp, "repos")}\n  workspaces_root: ${path.dirname(ws)}\n`,
    });
    return {
      text: reporter.text(),
      docker: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "",
    };
  } finally {
    if (prev === undefined) delete process.env.WERKMEISTER_DOCKER_BIN;
    else process.env.WERKMEISTER_DOCKER_BIN = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("no listed service: no build, an info line, no build warning", async () => {
  const { text, docker } = await init("");
  assert.match(text, /No local services: skipping the image build/);
  assert.doesNotMatch(text, /images may be incomplete/);
  assert.doesNotMatch(docker, /--no-start/);
});

test("a listed service still builds", async () => {
  const { text, docker } = await init("backend");
  assert.match(docker, /up --build --no-start/);
  assert.doesNotMatch(text, /skipping the image build/);
});
