// SW-427: the one fake gh and docker, run directly, so a verb change is tested on its own.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

import { writeFakes } from "./dist/fixture_fakes.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-fakes-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const run = (bin, ...args) => spawnSync(bin, args, { encoding: "utf8" });

test("gh: a label exists once created, unknown verbs fail, every call is logged", () => {
  const f = writeFakes(path.join(tmp, "gh"), { issue: { title: "t" } });
  assert.equal(run(f.gh, "issue", "edit", "1", "-R", "o/a", "--add-label", "x").status, 1);
  assert.equal(run(f.gh, "label", "create", "x").status, 0);
  assert.equal(run(f.gh, "issue", "edit", "1", "-R", "o/a", "--add-label", "x").status, 0);
  assert.deepEqual(JSON.parse(run(f.gh, "issue", "view", "1").stdout), { title: "t" });
  const unknown = run(f.gh, "release", "list");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /fake gh: unhandled: release list/);
  assert.equal(fs.readFileSync(f.ghLog, "utf8").trim().split("\n").length, 5);
});

test("docker: running containers show only to the gate's Names ps", () => {
  const f = writeFakes(path.join(tmp, "docker"), { running: ["demo-lib"] });
  assert.equal(
    run(f.docker, "ps", "--format", "{{.Names}}\t{{.State}}").stdout,
    "demo-lib\trunning\n",
  );
  assert.equal(run(f.docker, "ps", "-aq", "--filter", "label=x").stdout, "");
  assert.equal(run(f.docker, "rm", "x").status, 1);
  assert.match(fs.readFileSync(f.dockerLog, "utf8"), /^ps --format/);
});

test("docker exec: answers 0 by default; with execCwd runs the last argument there (SW-473)", () => {
  const off = writeFakes(path.join(tmp, "exec-off"));
  assert.equal(run(off.docker, "exec", "c", "sh", "-c", "false").status, 0);
  const cwd = path.join(tmp, "exec-cwd");
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "marker"), "");
  const on = writeFakes(path.join(tmp, "exec-on"), { execCwd: cwd });
  const pass = run(
    on.docker,
    "exec",
    "c",
    "sh",
    "-c",
    "wrapper",
    "sh",
    "-c",
    "test -f marker && echo ok",
  );
  assert.equal(pass.status, 0);
  assert.equal(pass.stdout, "ok\n");
  assert.equal(run(on.docker, "exec", "c", "sh", "-c", "exit 3").status, 3);
  assert.equal(fs.readFileSync(on.dockerLog, "utf8").trim().split("\n").length, 2);
});

test("gh pr view: OPEN by default, MERGED with a merge commit on request (SW-482)", () => {
  const view = (world) =>
    JSON.parse(
      run(
        writeFakes(path.join(tmp, `view-${world.prState}`), world).gh,
        "pr",
        "view",
        "u",
        "--json",
        "state",
      ).stdout,
    );
  assert.equal(view({}).state, "OPEN");
  const merged = view({ prState: "MERGED" });
  assert.equal(merged.state, "MERGED");
  assert.equal(merged.mergeCommit.oid.length, 40);
});
