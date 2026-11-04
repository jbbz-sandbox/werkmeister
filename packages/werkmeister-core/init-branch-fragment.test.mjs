// SW-337: a branch that changes a service's `command:` in its own
// .werkmeister/services.yaml must run that command in its feature containers
// before merge. Compose generation merges the worktree's fragment over the
// global registry for the workspace's repos; other repos' services and the
// registry file itself stay as they are.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { COMPOSE_FILE } from "./dist/compose_file.js";
import { initWorkspace } from "./dist/workspace_init.js";
import { pinWerkmeisterRoot, withSandboxHome } from "./fixtures.mjs";

pinWerkmeisterRoot();

const service = (name, repo, command) =>
  `  ${name}:\n    repo: ${repo}\n    type: api\n    port_offset: ${name === "backend" ? 2 : 3}\n    command: ${command}\n`;

test("init renders the worktree fragment's command over the registry's, leaves other repos and the registry alone (SW-337)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "init-branch-fragment-"));
  const ws = path.join(tmp, "features", "demo-ws");
  const worktree = path.join(ws, "demo-repo");
  fs.mkdirSync(path.join(worktree, ".git"), { recursive: true });
  fs.mkdirSync(path.join(worktree, ".werkmeister"));
  // The branch moved the entry point; the registry still holds main's command.
  fs.writeFileSync(
    path.join(worktree, ".werkmeister", "services.yaml"),
    `services:\n${service("backend", "demo-repo", "node src/server.ts").replace("    repo: demo-repo\n", "")}`,
  );
  fs.mkdirSync(path.join(ws, ".werkmeister"));
  fs.writeFileSync(
    path.join(ws, ".werkmeister", "workspace.yml"),
    "task: Branch fragment\nwork_type: bug\nfeature: demo\nservices: backend,web\ncontext_strategy: icm\n",
  );
  const registry =
    `services:\n${service("backend", "demo-repo", "node src/server.js")}` +
    `${service("web", "other-repo", "node web.js")}`;
  try {
    const { compose, after } = await withSandboxHome(
      async (home) => {
        await initWorkspace({}, ws, { build: false });
        return {
          compose: fs.readFileSync(path.join(ws, COMPOSE_FILE), "utf8"),
          after: fs.readFileSync(path.join(home, "services.yaml"), "utf8"),
        };
      },
      {
        services: registry,
        config: `paths:\n  repos_root: ${path.join(tmp, "repos")}\n  workspaces_root: ${path.dirname(ws)}\n`,
      },
    );
    assert.match(compose, /node src\/server\.ts/, "the branch's command");
    assert.doesNotMatch(compose, /node src\/server\.js/, "not the registry's");
    assert.match(compose, /node web\.js/, "another repo's service still comes from the registry");
    assert.equal(after, registry, "the registry file is untouched");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// SW-370: a feature name that already starts with the issue slug is not prefixed twice.
test("buildWorkspaceName: a feature carrying the issue slug is used as is (SW-370)", async () => {
  const { buildWorkspaceName } = await import("./dist/workspace_init.js");
  assert.equal(buildWorkspaceName("sw-356-up-dirty", "sw-356"), "sw-356-up-dirty");
  assert.equal(buildWorkspaceName("up-dirty", "sw-356"), "sw-356-up-dirty");
  assert.equal(buildWorkspaceName("sw-3560-x", "sw-356"), "sw-356-sw-3560-x");
  assert.equal(buildWorkspaceName("x", null), "x");
});
