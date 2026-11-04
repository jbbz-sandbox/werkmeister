// SW-292: the one seeded fixture built-CLI exercises and core tests share, replacing the
// hand-built seed the cli validate: text described (SW-234, SW-232, SW-251, SW-114).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { jiraCreds } from "./dist/jira-rest.js";
import { gatePrs } from "./dist/pr_lifecycle.js";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { initWorkspace } from "./dist/workspace_init.js";
import { pinWerkmeisterRoot, withFixtureWorkspace } from "./fixtures.mjs";

pinWerkmeisterRoot();

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("the fixture seeds a registry, a workspace and a code repo with a local origin", async () => {
  await withFixtureWorkspace(async (fx) => {
    assert.equal(process.env.WERKMEISTER_CONFIG_FILE, fx.configFile);
    assert.equal(process.env.WERKMEISTER_FIXTURE, "1");
    const config = fs.readFileSync(fx.configFile, "utf8");
    for (const key of ["repos_root", "workspaces_root", "services_yaml", "ports_yaml"])
      assert.match(config, new RegExp(`${key}: ${fx.root}/`));
    assert.equal(fs.lstatSync(path.join(fx.root, "services.yaml")).isSymbolicLink(), false);
    assert.match(fs.readFileSync(path.join(fx.root, "ports.yaml"), "utf8"), /base_port: 39100/);
    assert.match(
      fs.readFileSync(path.join(fx.workspace, ".werkmeister", "workspace.yml"), "utf8"),
      /^feature: demo$/m,
    );
    assert.equal(git(fx.repo, "branch", "--show-current"), "me/demo");
    assert.equal(
      git(fx.repo, "remote", "get-url", "origin"),
      path.join(fx.root, "remotes/o/app.git"),
    );
    assert.equal(
      git(path.join(fx.root, "repos/app"), "branch", "--show-current"),
      "fixture-source",
    );
  });
  assert.equal(process.env.WERKMEISTER_FIXTURE, undefined, "env restored");
});

test("a bare fixture has no feature, so close-out skips teardown (SW-114)", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      const yml = fs.readFileSync(path.join(fx.workspace, ".werkmeister", "workspace.yml"), "utf8");
      assert.doesNotMatch(yml, /^(feature|issue_id):/m);
    },
    { bare: true },
  );
});

test("the gate fixture's one-file change runs lib's test in its container, logged by the fake docker", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      // The gate's setup one-shot re-run starts from compose.yml, which init writes (SW-362).
      await withReporter(collectingReporter(), () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      const { ok, lines } = await gatePrs(fx.workspace, undefined, undefined, { wait: false });
      assert.equal(ok, true, lines.join("\n"));
      const calls = fs.readFileSync(fx.dockerLog, "utf8").split("\n");
      const execs = calls.filter((c) => c.startsWith("exec "));
      // The gate wraps the test in an inline with-temp-home (SW-329); the test command comes last.
      assert.equal(execs.length, 1, calls.join("\n"));
      assert.match(execs[0], /^exec demo-lib sh -c .* sh -c true$/);
    },
    { gate: true },
  );
});

test("caller-exported Jira credentials don't reach a fixture run", async () => {
  const prev = process.env.JIRA_API_TOKEN;
  Object.assign(process.env, {
    JIRA_BASE_URL: "https://real.atlassian.net",
    JIRA_EMAIL: "me@example.com",
    JIRA_API_TOKEN: "secret",
  });
  try {
    await withFixtureWorkspace(async () => assert.equal(await jiraCreds(), null));
    assert.equal(process.env.JIRA_API_TOKEN, "secret", "restored after");
  } finally {
    for (const k of ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"]) delete process.env[k];
    if (prev !== undefined) process.env.JIRA_API_TOKEN = prev;
  }
});
