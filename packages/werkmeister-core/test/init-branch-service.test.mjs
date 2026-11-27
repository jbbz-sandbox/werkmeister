// SW-936: a service the branch adds in its own .werkmeister/services.yaml owns a repo at init, as compose
// generation already reads it: no "Unknown service(s)" warning for it.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { collectingReporter, withReporter } from "../dist/reporter.js";
import { initWorkspace } from "../dist/workspace_init.js";
import { pinWerkmeisterRoot, withSandboxHome } from "./fixtures.mjs";

pinWerkmeisterRoot();

const service = (name, offset, repo) =>
  `  ${name}:\n${repo ? `    repo: ${repo}\n` : ""}    type: api\n    port_offset: ${offset}\n    command: node ${name}.js\n`;

test("init takes a branch-only service's repo from the worktree fragment (SW-936)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "init-branch-service-"));
  const ws = path.join(tmp, "features", "demo-ws");
  const worktree = path.join(ws, "demo-repo");
  fs.mkdirSync(path.join(worktree, ".git"), { recursive: true });
  fs.mkdirSync(path.join(worktree, ".werkmeister"));
  // The branch adds `queue`; main's registry has only `backend`.
  fs.writeFileSync(
    path.join(worktree, ".werkmeister", "services.yaml"),
    `services:\n${service("backend", 2)}${service("queue", 3)}`,
  );
  fs.mkdirSync(path.join(ws, ".werkmeister"));
  fs.writeFileSync(
    path.join(ws, ".werkmeister", "workspace.yml"),
    "task: t\nwork_type: bug\nfeature: demo\nrepos: demo-repo\nservices: backend,queue\ncontext_strategy: icm\n",
  );
  try {
    const reporter = collectingReporter();
    await withSandboxHome(
      () => withReporter(reporter, () => initWorkspace({}, ws, { build: false })),
      {
        services: `services:\n${service("backend", 2, "demo-repo")}`,
        config: `paths:\n  repos_root: ${path.join(tmp, "repos")}\n  workspaces_root: ${path.dirname(ws)}\n`,
      },
    );
    assert.doesNotMatch(reporter.text(), /Unknown service\(s\) in workspace\.yml/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
